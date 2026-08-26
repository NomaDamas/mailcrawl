# mailcrawl 구현 계획: katok 패턴 기반 증분 인덱싱·BM25·Semantic Search

## 0. 문서 목적과 기준

이 문서는 `mailcrawl`을 실제 구현 가능한 단계로 쪼갠 실행 계획이다. 현재
저장소는 설계 스캐폴드이므로, 아래 항목은 구현 전 설계 결정과 완료 기준을
정의한다.

참고 기준은 다음 두 문서/프로젝트다.

- 현재 설계: `README.md`, `docs/architecture.md`
- 참고 구현: [NomaDamas/katok](https://github.com/NomaDamas/katok)
- 핵심 참고 파일: `src/archive/write.rs`, `src/archive/read.rs`,
  `src/chunking.rs`, `src/search.rs`, `src/semantic/live.rs`,
  `src/semantic/store.rs`, `docs/incremental-chunking-tail-scope.md`

katok의 코드를 복사하지 않는다. 이메일은 카카오톡과 달리 서버 동기화,
메일박스, MIME, 스레드 답장, 첨부파일, 공급자별 cursor가 있으므로 동일한
불변식과 lifecycle만 mailcrawl 데이터 모델에 맞게 적용한다.

## 1. 목표 아키텍처

```text
Himalaya
  -> provider adapter
  -> envelope diff / bounded MIME fetch
  -> SQLite archive transaction
  -> normalization + versioned chunks
  -> SQLite FTS5/BM25
  -> durable embedding queue
  -> staged semantic generation
  -> stable JSON CLI
  -> AutoRAG/MCP/agent adapter
```

### 1.1 저장소 원칙

- SQLite가 메시지, 스레드, 청크, 동기화 상태, FTS의 source of truth다.
- Semantic index는 rebuild 가능한 별도 디렉터리 또는 DB다.
- FTS는 semantic index가 없거나 stale이어도 항상 사용할 수 있어야 한다.
- 원본 MIME과 추출 첨부파일은 기본 data directory 안에 저장하며 권한은
  사용자만 읽을 수 있는 모드로 만든다.
- 모든 변경 단계는 archive revision과 index generation으로 추적한다.
- 원문은 검색 결과에 기본 포함하지 않고 snippet과 안정 ID만 반환한다.

### 1.2 구현 언어와 라이브러리 결정

- 현재 Node/TypeScript 스캐폴드와 `package.json`을 유지한다.
- SQLite는 FTS5를 지원하는 native binding을 선택한다. 후보를 조사한 뒤
  하나로 고정하고, WASM-only fallback은 첫 구현 범위에 넣지 않는다.
- 임베딩은 provider interface 뒤에 둔다. 기본은 로컬 provider이며 원격
  provider는 명시적 opt-in 없이는 실행하지 않는다.
- LanceDB를 바로 강제하지 않는다. katok처럼 작은 로컬 vector store로 먼저
  correctness를 확보하고, 규모 요구가 확인되면 LanceDB adapter를 추가한다.
- CLI는 `--json`을 1급 계약으로 두고 사람이 읽는 출력은 JSON의 별도 renderer다.

## 2. Phase 1: 기반과 스키마

### 2.1 CLI 골격

구현 대상:

```text
mailcrawl doctor --json
mailcrawl status --json
mailcrawl sync --json
mailcrawl index --json
mailcrawl search keyword|bm25|semantic --json QUERY
mailcrawl message get MESSAGE_ID --json
mailcrawl thread get THREAD_ID --json
mailcrawl chunk get CHUNK_ID --json
mailcrawl chunk context CHUNK_ID --json
mailcrawl chunk parent CHUNK_ID --json
mailcrawl repair --fts|--semantic|--all --json
```

`embed`는 내부 queue drain을 외부에 노출할 필요가 있을 때만 alias로 둔다.
katok의 `sync`와 `index` 분리를 따르되, 사용자가 원하면 `search --ensure-fresh`
가 상태 확인 후 필요한 단계만 실행하도록 나중에 추가한다.

### 2.2 SQLite 스키마

필수 테이블:

- `accounts(account_id, provider, stable_key, display_name, ...)`
- `mailboxes(mailbox_id, account_id, remote_name, uid_validity, ...)`
- `messages(message_id, account_id, mailbox_id, provider_key, thread_id, ...)`
- `message_bodies(message_id, mime_hash, normalized_hash, raw_path, ...)`
- `threads(thread_id, account_id, normalized_subject, first_at, last_at, ...)`
- `attachments(attachment_id, message_id, content_hash, name, mime_type, ...)`
- `chunks(chunk_id, message_id, thread_id, section, ordinal, text, ...)`
- `chunk_messages(chunk_id, message_id, ordinal)`
- `thread_edges(child_message_id, parent_message_id, relation)`
- `sync_cursors(scope_key, cursor_kind, cursor_value, snapshot_state, ...)`
- `chunk_settings(id=1, normalizer_version, chunker_version, ...)`
- `embedding_queue(chunk_id, content_hash, model_id, state, attempts, ...)`
- `index_runs(run_id, archive_revision, status, ...)`
- `chunks_fts` FTS5 virtual table

`provider_key`는 Message-ID만 단독으로 믿지 않고 account/mailbox/provider
namespace와 함께 unique하게 만든다. Message-ID가 없는 메일은 provider가
제공한 UID와 envelope fingerprint를 조합한다.

### 2.3 revision과 hash

- envelope fingerprint: 변경 감지용 헤더/크기/수정시각/공급자 식별자 hash.
- MIME hash: 원본 MIME이 바뀌었는지 판단한다.
- normalized hash: HTML 제거·인용 제거 후 내용 변경을 판단한다.
- chunk content hash: 같은 `chunk_id`에서 임베딩을 재사용할지 판단한다.
- archive revision: 정렬된 `(chunk_id, content_hash)` 목록의 SHA-256.
- normalizer/chunker 설정 또는 버전 변경은 안전한 full rebuild 신호다.

## 3. Phase 2: Himalaya 동기화와 증분 archive

### 3.1 provider adapter 계약

adapter는 아래 기능만 제공하고 archive 계층은 provider 세부사항을 모른다.

```ts
interface MailSource {
  listMailboxes(): AsyncIterable<MailboxEnvelope>;
  listEnvelopes(scope: MailboxScope, page: Page): Promise<EnvelopePage>;
  fetchMessage(scope: MailboxScope, key: ProviderMessageKey): Promise<RawMime>;
  capabilities(): Promise<SourceCapabilities>;
}
```

초기 구현은 Himalaya CLI subprocess adapter와 deterministic fixture adapter로
한정한다. subprocess 인자에는 계정·backend·mailbox만 전달하고 credential 값은
읽거나 로그에 남기지 않는다.

### 3.2 안전한 sync 알고리즘

1. mailbox별 bounded envelope page를 읽는다.
2. complete snapshot인지, cursor/delta 결과인지 응답 상태를 기록한다.
3. stable provider key와 envelope fingerprint를 계산한다.
4. 신규 또는 fingerprint 변경 메일만 full MIME을 가져온다.
5. MIME을 normalize하고 MIME/normalized hash를 비교한다.
6. 변경된 메시지만 한 SQLite transaction에서 upsert한다.
7. 완전한 snapshot이 확인된 mailbox 안에서만 누락 메일을 deleted 처리한다.
8. 삭제·변경 메시지의 mailbox/thread를 touched scope에 넣는다.
9. chunk tail을 재계산하고 FTS를 같은 transaction에서 갱신한다.
10. 변경 chunk를 embedding queue에 idempotently 넣고 transaction을 commit한다.

### 3.3 katok식 tail-scoped 재계산을 이메일에 적용

메일은 같은 thread에 과거 메시지가 뒤늦게 도착하거나 라벨이 바뀔 수 있으므로
무조건 마지막 chunk만 재계산하지 않는다.

- scope 단위는 기본 `thread_id`; thread를 신뢰할 수 없으면 `mailbox_id` 단위로
  보수적으로 넓힌다.
- 변경 메시지 중 가장 이른 `(sent_at, message_id)`를 `e`로 계산한다.
- 기존 chunk/parent window에서 `e`보다 앞선 마지막 안정 window의 시작을 `P`로 잡는다.
- `P` 이전 청크는 경계 함수가 local이고 stable ID가 내용 기반일 때 보존한다.
- 답장 연결, subject 정규화, parent window 누적 길이는 `P`부터 다시 계산한다.
- thread merge/split, Message-ID/In-Reply-To 변경, 삭제는 관련 thread 전체를 rebuild한다.
- 설정/정규화/청커 버전 변경, 최초 sync, integrity failure는 full rebuild한다.
- 경계가 local이라는 가정을 깨는 변경은 test equivalence가 잡아야 한다.

### 3.4 sync 출력

```json
{
  "added": 0,
  "updated": 0,
  "deleted": 0,
  "unchanged": 0,
  "touched_threads": 0,
  "rebuilt_threads": 0,
  "chunks_added": 0,
  "chunks_deleted": 0,
  "embedding_backlog": 0,
  "archive_revision": "sha256...",
  "timings_ms": {}
}
```

`--touched`를 명시한 경우에만 thread/message 식별자 목록을 반환해 기본 출력
노출을 줄인다. 부분 응답이면 `deletion_skipped: true`와 이유를 반환한다.

## 4. Phase 3: 이메일 인식 정규화와 청킹

### 4.1 MIME 정규화

- RFC 5322 헤더를 decode하고 주소를 canonical form으로 저장한다.
- text/plain을 우선하고 HTML은 DOM 기반으로 text로 변환한다.
- HTML과 plain text가 모두 있으면 중복 본문을 제거한다.
- `On ... wrote:`, `>`, Outlook/Gmail reply marker 등 인용 영역을 감지한다.
- 최신 authored body, quoted history, forwarded body, signature를 section으로
  분류하되 원문 보존 정책에 따라 raw MIME 링크를 유지한다.
- malformed MIME은 전체 sync를 중단하지 않고 message diagnostic과 함께
  fallback text를 만든다.

### 4.2 child chunk와 parent window

katok의 micro chunk/parent window 계층을 이메일에 적용한다.

- child chunk: 한 메시지의 section 또는 인접한 짧은 본문 단위.
- parent window: 같은 thread에서 시간 간격과 최대 문자 수를 고려해 인접
  child chunk를 묶은 semantic 검색 단위.
- 검색은 parent를 찾아도 child/message/thread ID를 함께 돌려 원문으로 이동한다.
- parent ID는 thread, 첫/마지막 child ID, parent schema version으로 안정 생성한다.
- sender/recipient/subject/date metadata는 child와 parent 모두에 넣는다.
- quoted history는 기본 검색 text에서 낮은 가중치 또는 별도 section으로 둔다.

### 4.3 chunk 불변식

- chunk 경계 함수는 인접 메시지/section과 설정만 읽는다.
- ID는 ordinal 단독이 아니라 source identity와 경계 ID/hash를 사용한다.
- 모든 FTS row는 `chunks.rowid`를 docid로 사용한다.
- `chunks_fts.rowid`와 `chunks.rowid` 정합성을 doctor/repair에서 검사한다.
- full rebuild와 tail rebuild 결과가 byte-for-byte 동일해야 한다.
- 정책 변경은 `chunker_version` 증가로 감지하고 전체 재계산한다.

## 5. Phase 4: BM25 / FTS5

### 5.1 FTS schema와 필드

FTS5에 다음 검색 필드를 둔다.

```text
subject
from_address
to_addresses
cc_addresses
thread_subject
body_latest
body_quoted
forwarded_text
attachment_text
```

주소·subject 필드는 별도 컬럼으로 저장해 향후 field filter와 weighting을
가능하게 한다. FTS 외부 content table을 쓸 경우 rowid 매핑을 명시적으로
관리하고, 단순 contentless 설계는 원문 hydrate가 어려워 첫 구현에서는 피한다.

### 5.2 query 안전성

- 일반 검색어는 FTS5 boolean 문법으로 실행하지 않고 term별 literal quote 처리한다.
- 빈 query는 명확한 non-zero 오류와 JSON error code를 반환한다.
- `--from`, `--to`, `--cc`, `--mailbox`, `--thread`, `--after`, `--before`는
  FTS MATCH와 SQL metadata predicate를 분리한다.
- 주소 필터는 display name이 아닌 canonical email address 기준을 기본값으로 한다.
- subject와 sender exact match를 높은 가중치로 두고 본문·인용·첨부 텍스트는
  낮은 가중치를 준다. 최종 weighting은 fixture ranking으로 고정한다.

### 5.3 BM25 결과와 원문 탐색

결과는 `chunk_id`, `message_id`, `thread_id`, `rank`, `bm25_score`,
`snippet`, subject/from/to/date를 반환한다. 원문은 후속 명령으로만 가져온다.

```text
mailcrawl search bm25 "계약 갱신" --from sender@example.com --json
mailcrawl chunk get <chunk-id> --json
mailcrawl chunk context <chunk-id> --json
mailcrawl thread get <thread-id> --before <message-id> --after <message-id> --json
mailcrawl message get <message-id> --include-body --json
```

`context`는 같은 thread의 바로 이전/이후 child chunk를 반환한다. `thread get`
은 시간순 메시지와 reply edge를 반환하며 sender/recipient/date 범위를 추가로
필터링한다. 검색 hit 자체에는 짧은 snippet만 넣어 에이전트가 능동적으로
좁혀가도록 한다.

## 6. Phase 5: Semantic search

### 6.1 provider interface

```ts
interface Embedder {
  id(): string;
  dimension(): number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}
```

- 기본 모델과 dimension을 config에 고정하고 모든 vector row에 model ID를 저장한다.
- 테스트에는 deterministic mock embedder를 제공한다.
- batch size, concurrency, timeout, model cache path를 설정 가능하게 한다.
- 원격 endpoint는 explicit opt-in 없이는 거부한다.
- 임베딩 실패는 queue에 실패 이유·attempt를 남기되 FTS를 막지 않는다.

### 6.2 generation lifecycle

katok의 generation 전략을 그대로 채택한다.

1. archive revision을 계산한다.
2. semantic writer lock을 획득한다.
3. `semantic/generations/.gen-*.staging`을 생성한다.
4. 현재 parent documents를 staging에 쓴다.
5. 이전 healthy generation에서 `(unit_id, content_hash, model_id)`가 같은
   vector를 재사용한다.
6. 나머지만 batch embedding한다.
7. cursor와 manifest를 쓰고 archive/vector ID/hash 정합성을 검증한다.
8. staging을 완성 generation으로 rename한다.
9. `CURRENT` pointer를 임시 파일 rename으로 원자 교체한다.
10. 이전 generation은 보존 기간 후 정리하고 실패 시 warning을 반환한다.

실패하면 `CURRENT`는 이전 healthy generation을 계속 가리켜야 한다. semantic
검색 시작 시 archive revision과 cursor revision을 비교하고 다르면 stale 오류를
반환한다. 필요하면 CLI가 자동 index하지 않고 권고 명령을 JSON으로 제시한다.

### 6.3 vector store 초기 구현

- 초기에는 SQLite `vectors` 테이블 또는 검증된 local store로 구현한다.
- row에는 `unit_id`, `message_id`, `thread_id`, `content_hash`, `model_id`,
  `dimension`, `vector`, `seen_revision`을 둔다.
- 검색은 cosine/dot product 중 embedder가 정규화한 방식 하나로 고정한다.
- 작은 데이터에서는 전체 vector scan으로 correctness를 먼저 확보한다.
- 성능 기준을 넘으면 LanceDB adapter를 추가하되 CLI와 manifest는 유지한다.
- vector ID가 archive에 없거나 hash가 다르면 semantic index를 stale/self-heal로
  분류한다.

## 7. Phase 6: Hybrid retrieval

- BM25와 semantic을 각각 독립 실행한다.
- 각 결과 집합을 rank-based score 또는 min-max 방식으로 정규화한다.
- 동일 message/thread의 child hit를 dedupe하되, best chunk와 supporting IDs를
  보존한다.
- 기본 가중치는 BM25 0.5, semantic 0.5로 시작하고 fixture benchmark로 조정한다.
- 필터는 두 검색기에 동일하게 적용해 semantic 후보가 범위를 벗어나지 않게 한다.
- vector index가 missing/stale이면 BM25-only fallback을 수행하고 diagnostics에
  `semantic_fallback: "fts"`를 기록한다.
- 정렬 tie-breaker는 normalized score, BM25 rank, semantic rank, chunk ID 순으로
  고정해 실행마다 결과가 바뀌지 않게 한다.

## 8. Phase 7: 첨부파일

### 8.1 수집과 저장

- MIME parser가 attachment metadata를 추출하고 `attachments`에 기록한다.
- 원본 파일은 기본적으로 자동 다운로드하지 않는다.
- 텍스트 추출이 안전하고 지원되는 형식만 opt-in 또는 설정에 따라 수행한다.
- PDF, DOCX, XLSX, HWP/HWPX, TXT/CSV를 우선 후보로 조사한다.
- 이미지 OCR과 압축파일 내부 추출은 초기 범위에서 제외하거나 별도 명령으로 둔다.
- 파일명·mime·size·hash·추출 상태·오류만 검색 메타데이터에 넣는다.
- path traversal을 방지하고 원본 이름은 표시용으로만 사용한다.
- 최대 파일 크기, 최대 추출 문자 수, 실행 시간 제한을 둔다.

### 8.2 검색과 backfill

```text
mailcrawl attachment list --message <id> --json
mailcrawl attachment get <attachment-id> --out <dir> --json
mailcrawl attachment extract <attachment-id> --json
mailcrawl attachment backfill --dry-run --json
```

첨부 텍스트가 바뀌면 attachment content hash를 통해 해당 message/thread의
normalization, FTS, embedding을 다시 queue한다. 원본 다운로드가 실패해도
메일 본문 검색은 계속 가능해야 한다. 만료 가능한 remote URL이 있다면 katok의
backfill처럼 dry-run, 멱등성, hash 검증, 재시작 가능 상태를 제공한다.

## 9. Phase 8: freshness, repair, diagnostics

`doctor --json`은 권한 prompt 없이 archive/index freshness를 확인한다.

```json
{
  "archive_revision": "sha256...",
  "last_sync": "...",
  "last_index": "...",
  "fts": {"status": "healthy", "rows": 0},
  "semantic": {
    "status": "healthy|missing|stale|corrupt",
    "model": "...",
    "dimension": 0
  },
  "recommendation": {
    "sync_before_search": false,
    "index_before_semantic_search": true,
    "reason": "..."
  }
}
```

repair:

- `repair --fts`: chunks와 FTS rowid 매핑을 검증하고 FTS만 재구성한다.
- `repair --semantic`: 현재 archive에서 새 generation을 만든다.
- `repair --all`: SQLite invariant, FTS, semantic 순서로 복구한다.
- 모든 repair는 원자적이며, 실패 시 기존 index를 보존한다.
- diagnostics는 bounded/redacted하고 원문 body·credential·전체 path를 출력하지 않는다.

## 10. Phase 9: 테스트 우선 구현 순서

1. fake Himalaya adapter와 CLI JSON schema test.
2. envelope fingerprint와 unchanged sync idempotency test.
3. 신규/변경/안전한 삭제/불완전 snapshot deletion guard test.
4. MIME plain/HTML/quoted/forwarded/signature fixture test.
5. chunk ID 안정성 및 설정/version full rebuild test.
6. append tail rebuild와 full rebuild 결과 동등성 test.
7. mid-thread edit, late reply, thread merge/split, deletion test.
8. FTS rowid 매핑·BM25 ranking·literal query escaping test.
9. sender/recipient/mailbox/date filter test.
10. mock embedder batch, reuse, failed queue, model mismatch test.
11. generation failure, stale cursor, CURRENT atomic publish test.
12. hybrid dedupe, fallback, deterministic tie-break test.
13. attachment extraction limit, path safety, hash, backfill idempotency test.
14. end-to-end sync → index → bm25/semantic/hybrid → message/thread context test.

테스트는 실제 메일 계정이나 실제 원문을 사용하지 않고 합성 fixture만 사용한다.
시간 기반 비동기는 sleep 대신 명시적인 queue state/event를 기다린다.

## 11. 구현 순서와 산출물

### Milestone A: archive contract

- `src/types`, `src/archive`, SQLite migration, fixture source, `doctor/status`.
- 완료: fixture sync가 두 번 실행되어 두 번째 실행에서 변경 0을 보고한다.

### Milestone B: normalization/chunking

- MIME parser, normalized message model, child/parent chunker, versioning.
- 완료: full rebuild와 incremental rebuild의 모든 row가 동일하다.

### Milestone C: BM25

- FTS5 schema, rowid mapping, filters, snippets, message/thread context commands.
- 완료: 일반 검색·주소 필터·이전/이후 context가 JSON으로 동작한다.

### Milestone D: semantic

- embedder interface, mock/local provider, queue, generation, CURRENT, freshness.
- 완료: 변경되지 않은 chunk는 embedding call 없이 재사용되고 실패 generation은
  이전 generation을 손상시키지 않는다.

### Milestone E: hybrid/attachments

- hybrid ranker, attachment metadata/extraction/backfill, repair.
- 완료: semantic unavailable 상태에서도 BM25 fallback이 동작하고 첨부 텍스트가
  검색된다.

### Milestone F: release quality

- Himalaya 실제 adapter, benchmark, docs, packaging, privacy audit.
- 완료: typecheck, 관련 테스트, build, CLI manual QA가 모두 통과한다.

## 12. Manual QA gate

실제 fixture workspace에서 다음을 직접 실행하고 JSON을 읽는다.

```bash
mailcrawl doctor --json
mailcrawl sync --source fixture ./tests/fixtures/mail --json
mailcrawl sync --source fixture ./tests/fixtures/mail --json
mailcrawl index --embedder mock --json
mailcrawl search bm25 "계약 갱신" --from sender@example.com --json
mailcrawl search semantic "갱신 조건" --json
mailcrawl chunk context <chunk-id> --json
mailcrawl thread get <thread-id> --before <message-id> --after <message-id> --json
mailcrawl search --bad-mode --json "x"
mailcrawl --help
```

관찰해야 할 결과:

- 두 번째 sync는 실제 변경만 처리한다.
- BM25는 sender filter와 subject/body ranking을 적용한다.
- semantic은 mock provider로 재현 가능하고 stale이면 명확한 오류/권고를 낸다.
- chunk context/thread get은 검색 결과에서 이전·이후 탐색을 가능하게 한다.
- 첨부파일 추출 실패가 본문 검색을 망가뜨리지 않는다.
- 모든 실패 경로가 non-zero와 구조화된 redacted 진단을 낸다.

## 13. 위험과 명시적 보수성

- Himalaya 출력 포맷이 provider별로 다르면 adapter에서 normalize하고 core에는
  안정 타입만 전달한다.
- IMAP snapshot이 완전하지 않으면 삭제하지 않는다.
- In-Reply-To가 없거나 충돌하면 subject/time 기반 thread heuristic을 쓰되,
  thread ID 변경은 전체 thread rebuild로 처리한다.
- 첨부파일 추출기는 untrusted input으로 취급하고 외부 프로세스 실행을 제한한다.
- remote embedding은 privacy 경계를 깨므로 기본 거부한다.
- Vector 성능 최적화는 정확성·generation 검증 후 진행한다.
- katok의 tail-scope 증명은 경계 함수가 local일 때만 유효하므로, 전역 문맥을
  읽는 chunk 규칙을 추가하면 먼저 full rebuild로 되돌리고 새 equivalence proof를
  작성한다.

## 14. 완료 정의

이 계획의 최종 완료는 다음을 모두 만족하는 상태다.

- Himalaya에서 안전하게 incremental archive sync가 된다.
- FTS5/BM25와 semantic search가 독립적으로 동작한다.
- hybrid가 deterministic하게 결합되고 semantic 장애 시 BM25로 fallback한다.
- 검색 결과에서 message/thread/chunk context로 이전·이후 내용을 탐색할 수 있다.
- 발신자·수신자·메일박스·기간 필터가 모든 검색 mode에 일관되게 적용된다.
- 첨부 metadata와 지원 형식의 추출 텍스트가 인덱싱된다.
- full/incremental rebuild가 동등하고 index generation이 원자적으로 교체된다.
- typecheck, build, 관련 테스트, 실제 CLI manual QA가 통과한다.

