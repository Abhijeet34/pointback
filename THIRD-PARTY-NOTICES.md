# Third-party notices

Runtime dependencies shipped with this package, with their licences.
pointback's own code is Apache-2.0; `LICENSE` carries that text and this file carries nobody else's.
Development-only tooling (eslint, prettier, typescript, @types/node) is not shipped and is not listed.

## parse5 8.0.1

MIT. Copyright (c) 2013-2019 Ivan Nikulin.
Used to insert the review SDK into an artifact as a DOM node rather than by splicing text.
Licence text: `node_modules/parse5/LICENSE`.

## markdown-it 15.0.2

MIT. Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.
Renders a Markdown file under review into a page, keeping each block's source lines.
Licence text: `node_modules/markdown-it/LICENSE`.

## linkify-it 6.1.0, mdurl 2.1.0 (dependencies of markdown-it)

MIT. Copyright (c) 2015 Vitaly Puzrin (linkify-it), and Vitaly Puzrin, Alex Kocharin (mdurl).
Licence texts: `node_modules/linkify-it/LICENSE`, `node_modules/mdurl/LICENSE`.

## uc.micro 3.0.0, punycode.js 2.3.1 (dependencies of markdown-it)

MIT. Copyright Mathias Bynens.
Licence texts: `node_modules/uc.micro/LICENSE.txt`, `node_modules/punycode.js/LICENSE-MIT.txt`.

## argparse 3.0.2 (dependency of markdown-it)

PSF-2.0. Copyright (c) 2001-2019 Python Software Foundation.
Installed with markdown-it for its own command-line tool; pointback never loads it.
Licence text: `node_modules/argparse/LICENSE`.

## entities 8.0.0 (dependency of parse5 and markdown-it)

BSD-2-Clause. Copyright (c) Felix Böhm.
Licence text: `node_modules/entities/LICENSE`.

## Archivo

SIL Open Font License 1.1. Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo).
The chrome's interface face, vendored from the house design system and served by the daemon itself.
Licence text: `src/browser/house/fonts/archivo/OFL.txt`.

## IBM Plex Mono

SIL Open Font License 1.1. Copyright © 2017 IBM Corp. with Reserved Font Name "Plex".
The chrome's face for file names, vendored from the house design system and served by the daemon itself.
Licence text: `src/browser/house/fonts/ibm-plex-mono/OFL.txt`.

## Literata

SIL Open Font License 1.1. Copyright 2017 The Literata Project Authors (https://github.com/googlefonts/literata).
The reading face of a rendered Markdown page, vendored from the house design system and served by the daemon itself.
Licence text: `src/browser/house/fonts/literata/OFL.txt`.
