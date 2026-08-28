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

## Kagome and IPADIC

- Kagome: https://github.com/ikawaha/kagome (MIT)
- Kagome dictionary: https://github.com/ikawaha/kagome-dict
  (IPADIC/ICOT terms apply)

## GSE

- Source: https://github.com/go-ego/gse
- License: Apache-2.0

`tools/mailcrawl-zh` uses the same persistent helper protocol as discrawl PR
#180 and is built separately from the default Node package.

## FastEmbed

- Source: https://github.com/Anush008/fastembed-js
- License: MIT

Downloaded embedding models have their own model-card licenses and are not
redistributed by mailcrawl.
