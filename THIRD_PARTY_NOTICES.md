# Third-party notices

mailcrawl is MIT-licensed. Runtime components retain their upstream licenses.

The application source remains MIT. These notices are for bundled source and
runtime dependencies; they do not relicense mailcrawl itself.

## Kiwi / kiwi-nlp

- Package: https://www.npmjs.com/package/kiwi-nlp
- Source: https://github.com/bab2min/Kiwi
- License: LGPL-2.1-or-later

The Kiwi package is not modified by mailcrawl.

## Japanese helper

`tools/mailcrawl-ja` follows the Kagome helper design used by discrawl PR
#180 and is built separately from the default Node package.
Kagome does not currently provide an official Node binding.

## Kagome and IPADIC

- Kagome: https://github.com/ikawaha/kagome (MIT)
- Kagome dictionary: https://github.com/ikawaha/kagome-dict
  (IPADIC/ICOT terms apply)

## GSE

- Source: https://github.com/go-ego/gse
- License: Apache-2.0

`tools/mailcrawl-zh` uses the same persistent helper protocol as discrawl PR
#180 and is built separately from the default Node package.
The GSE repository mentions `gse-bind`, but no usable npm package was available
at integration time, so this remains a separate Go helper.

## EmbeddingGemma

- Model: https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX
- Base model: Google EmbeddingGemma
- Terms: https://ai.google.dev/gemma/terms

The model is downloaded and executed locally through Transformers.js and ONNX
Runtime. Model weights are not redistributed in the mailcrawl package.

## Transformers.js

- Source: https://github.com/huggingface/transformers.js
- License: Apache-2.0
