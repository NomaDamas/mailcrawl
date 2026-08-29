# Multilingual analyzer installation

This guide covers the runtime components used by mailcrawl's lexical search.
Korean runs through the `kiwi-nlp` WebAssembly binding. Japanese and Chinese
use persistent Go helpers because Kagome has no official Node binding and the
GSE project does not currently publish a usable `gse-bind` npm package. English
uses SQLite's built-in Unicode tokenizer, and Arabic uses mailcrawl's
in-process light stemmer.

Semantic search uses Google's EmbeddingGemma through Transformers.js and ONNX
Runtime on the local machine. The model is downloaded to the local
Transformers cache on first use and is not a hosted service.

## 1. Install Node.js dependencies

Use Node.js 24 or newer:

```bash
node --version
npm install
npm run build
```

The `kiwi-nlp` package is installed by `npm install`. Its WASM binary is
resolved automatically from the installed package.

## 2. Configure the Korean Kiwi model

The npm package contains the Kiwi WASM engine, but the model files are
distributed separately. Set `MAILCRAWL_KIWI_MODEL` to a directory containing
the matching files from the same Kiwi release:

```bash
export MAILCRAWL_KIWI_MODEL="$HOME/.local/share/mailcrawl/kiwi-model"
```

For Kiwi `v0.23.x`, point to the model variant directory, usually
`cong/base`. The directory must contain the model assets for that release.

```text
combiningRule.txt
default.dict
extract.mdl
multi.dict
cong.mdl
sj.morph
typo.dict
```

To use a different WASM file:

```bash
export MAILCRAWL_KIWI_WASM="/path/to/kiwi-wasm.wasm"
```

Older Kiwi releases may use `sj.knlm` and `skipbigram.mdl` instead. Keep the
WASM and model files from compatible Kiwi releases. A missing model
configuration is an error for production Korean indexing; mailcrawl does not
silently substitute its test tokenizer.

## 3. Install Go

Go is required only for Japanese and Chinese lexical helpers. Install Go 1.26
or newer, then verify it:

```bash
go version
```

If you do not need Japanese or Chinese search, you can omit this step and
leave the corresponding helper unset.

## 4. Build the Japanese Kagome helper

From the mailcrawl repository:

```bash
mkdir -p "$HOME/.local/bin"
(cd tools/mailcrawl-ja && go build -trimpath -o "$HOME/.local/bin/mailcrawl-ja" .)
export MAILCRAWL_JA_HELPER="$HOME/.local/bin/mailcrawl-ja"
```

The helper embeds Kagome's IPADIC dictionary and stays alive as a persistent
JSON-lines process. It reports a `ready` response at startup and accepts
`{"text":"..."}` requests.

Smoke test:

```bash
printf '{"text":"契約更新を確認"}\n' | "$MAILCRAWL_JA_HELPER"
```

The output should contain Japanese lexical terms such as `契約` and `更新`.

## 5. Build the Chinese GSE helper

Build and configure the Chinese helper:

```bash
(cd tools/mailcrawl-zh && go build -trimpath -o "$HOME/.local/bin/mailcrawl-zh" .)
export MAILCRAWL_ZH_HELPER="$HOME/.local/bin/mailcrawl-zh"
```

Smoke test:

```bash
printf '{"text":"合同更新确认"}\n' | "$MAILCRAWL_ZH_HELPER"
```

The output should contain Chinese lexical terms such as `合同` and `更新`.

## 6. Persist the environment

Put the exports in the shell startup file used to run mailcrawl, or provide
them through the service manager that launches it:

```bash
export MAILCRAWL_KIWI_MODEL="$HOME/.local/share/mailcrawl/kiwi-model"
export MAILCRAWL_JA_HELPER="$HOME/.local/bin/mailcrawl-ja"
export MAILCRAWL_ZH_HELPER="$HOME/.local/bin/mailcrawl-zh"
```

The helper paths may instead be plain executable names when they are on
`PATH`.

## 7. Verify mailcrawl

Run the project checks:

```bash
npm run typecheck
npm test
npm run build
```

Then synchronize and search:

```bash
mailcrawl sync --json
mailcrawl search --mode bm25 --json "계약 갱신"
mailcrawl search --mode bm25 --json "契約 更新"
mailcrawl search --mode bm25 --json "合同 更新"
mailcrawl search --mode bm25 --json "كتاب"
mailcrawl search --mode bm25 --json "contract renewal"
mailcrawl index --json
mailcrawl search --mode semantic --json "contract renewal"
```

## 8. Lexical rebuild policy

Language-specific FTS fields are derived artifacts. Their version fingerprint
includes the Kiwi, Kagome, GSE, and Arabic analyzer versions. On a fingerprint
change, mailcrawl clears those fields and marks them stale. The next complete
`mailcrawl sync` re-analyzes changed and existing messages from the source and
commits the new fingerprint atomically. Multilingual search fails clearly until
that sync completes; the default Unicode FTS remains independent.

Semantic vectors are separate derived artifacts. Changing the embedding model
or its preprocessing requires a new semantic generation; run `mailcrawl index`
after synchronization. Existing lexical fields remain valid when only the
embedding model changes.

## Packaging and licenses

mailcrawl remains MIT-licensed. `kiwi-nlp` and Kiwi remain
LGPL-2.1-or-later components. Kagome is MIT-licensed, its IPADIC dictionary
has separate IPADIC/ICOT terms, and GSE is Apache-2.0. See
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) before redistributing
the application or helper binaries.

## 9. Semantic model

Semantic indexing uses `onnx-community/embeddinggemma-300m-ONNX` with
Transformers.js and ONNX Runtime on CPU. The first `mailcrawl index` downloads
the model to the local Transformers cache; later runs reuse that cache. The
model is not sent to a remote embedding service.
