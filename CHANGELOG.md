# Changelog

## [0.1.8](https://github.com/Abhijeet34/pointback/compare/v0.1.7...v0.1.8) (2026-10-15)


### Bug Fixes

* **browser:** batch of chrome/SDK robustness fixes for save, backoff, and pin perf ([#114](https://github.com/Abhijeet34/pointback/issues/114)) ([5d0634d](https://github.com/Abhijeet34/pointback/commit/5d0634db0356dcf198121551a8bbae089110f743))
* **browser:** batch of layout, motion, and font-recovery fixes ([#123](https://github.com/Abhijeet34/pointback/issues/123)) ([1a2c296](https://github.com/Abhijeet34/pointback/commit/1a2c2961b9fda78a94395990fd71a49f8826905f))
* **browser:** clear a stale live reload notice and turn Annotate off in a superseded tab behind the file ([#116](https://github.com/Abhijeet34/pointback/issues/116)) ([b1fc43b](https://github.com/Abhijeet34/pointback/commit/b1fc43bb19e5bf6ccf41b9405a4a7469dbff5e56))
* **browser:** close focus hand-off gaps between chrome and page ([#111](https://github.com/Abhijeet34/pointback/issues/111)) ([3aa695e](https://github.com/Abhijeet34/pointback/commit/3aa695eb70379dbe69a9d7968ab27c0f6e629959))
* **browser:** draw agent presence from the stream's hello, not its open ([#103](https://github.com/Abhijeet34/pointback/issues/103)) ([4710fee](https://github.com/Abhijeet34/pointback/commit/4710feece32be585220ca625ec86ab012a2b93cc))
* **browser:** fix pin, ring, code-wrap, and rubber-band visual defects ([#99](https://github.com/Abhijeet34/pointback/issues/99)) ([f9e020f](https://github.com/Abhijeet34/pointback/commit/f9e020fd45c82acd6908a82cc15a636f65fcc4ac))
* **browser:** follow the reviewer's light or dark preference in the chrome, Markdown and pins ([#113](https://github.com/Abhijeet34/pointback/issues/113)) ([536fb97](https://github.com/Abhijeet34/pointback/commit/536fb9723391a1e942d1f6ba5d5a273048306d78))
* **browser:** keep the outside-asset notice live and disable margin edits while offline ([#119](https://github.com/Abhijeet34/pointback/issues/119)) ([419cbb9](https://github.com/Abhijeet34/pointback/commit/419cbb9d5cda1518d5bf388d9468b7cea011cedb))
* **browser:** keep the review on screen when a chrome file is refused offline ([#107](https://github.com/Abhijeet34/pointback/issues/107)) ([73dfc80](https://github.com/Abhijeet34/pointback/commit/73dfc8037d8900368f170c66b1ac9171bbe12fd6))
* **browser:** load a review's page and frame once per open in every engine ([#106](https://github.com/Abhijeet34/pointback/issues/106)) ([9570fc2](https://github.com/Abhijeet34/pointback/commit/9570fc24fd0c22c0265cf3ffdf2b457559201653))
* **browser:** place pins and the note card clear of their targets, fix dark-scheme highlight contrast ([#127](https://github.com/Abhijeet34/pointback/issues/127)) ([6f60c06](https://github.com/Abhijeet34/pointback/commit/6f60c0657cd33945851c4ba16672e0207ce22ec3))
* **browser:** redraw a passage's highlight ring on scroll and resize ([#132](https://github.com/Abhijeet34/pointback/issues/132)) ([05457cd](https://github.com/Abhijeet34/pointback/commit/05457cd02ede91e61eedaf28322172164f73e0da))
* **browser:** settle the review-follow signal and harden the browser test harness ([#105](https://github.com/Abhijeet34/pointback/issues/105)) ([fbfe1d7](https://github.com/Abhijeet34/pointback/commit/fbfe1d74a090fea4c51db222a8104b0a055de932))
* **browser:** tell reviewers to ask their agent, not run a command, and fix sdk raw querySelector ([#125](https://github.com/Abhijeet34/pointback/issues/125)) ([cb92a7e](https://github.com/Abhijeet34/pointback/commit/cb92a7eded26efd2aba4a69316f6f77e74069fb0))
* **cli:** correct error messages, answer outline, and cap refusal ([#112](https://github.com/Abhijeet34/pointback/issues/112)) ([051932d](https://github.com/Abhijeet34/pointback/commit/051932dbd4444cbf69408a0b3b260c91cc493ea5))
* **client:** bound daemon requests, resolve state dir, and stop a WebKit postMessage error ([#122](https://github.com/Abhijeet34/pointback/issues/122)) ([f29bab1](https://github.com/Abhijeet34/pointback/commit/f29bab11dd0e2ce97ee06dce6a09bb3a5bd29af9))
* **client:** name the port to free on a refused open, never an unverified pid ([#117](https://github.com/Abhijeet34/pointback/issues/117)) ([7b13a74](https://github.com/Abhijeet34/pointback/commit/7b13a74123b915bc6b884f5dce6bf2624a7a67f5))
* **cli:** stop reports stopped for a daemon that exits after its deadline ([#108](https://github.com/Abhijeet34/pointback/issues/108)) ([d546e54](https://github.com/Abhijeet34/pointback/commit/d546e54749a8e89a0fadc4cf883e9c307de02544))
* **daemon:** close a failed start and keep stop meaning stopped ([#98](https://github.com/Abhijeet34/pointback/issues/98)) ([f58fd8a](https://github.com/Abhijeet34/pointback/commit/f58fd8a4fca7a1edfc835827d94e337e792f3458))
* **daemon:** close a running daemon once its state directory is removed ([#118](https://github.com/Abhijeet34/pointback/issues/118)) ([97940bd](https://github.com/Abhijeet34/pointback/commit/97940bd6c795009c484687d95993768aa2657393))
* **daemon:** free an event stream's slot when its client leaves with only a FIN ([#115](https://github.com/Abhijeet34/pointback/issues/115)) ([7a97c75](https://github.com/Abhijeet34/pointback/commit/7a97c7552fcc6b23966f424c3069efdc202f86b0))
* **events:** number a save made while no stream follows the review ([#129](https://github.com/Abhijeet34/pointback/issues/129)) ([ff9f2ae](https://github.com/Abhijeet34/pointback/commit/ff9f2ae6b3ff74cbe5ca602a15a55ab0ffe1637f))
* **open:** refuse non-regular files and show a page for spent links ([#124](https://github.com/Abhijeet34/pointback/issues/124)) ([b8865ef](https://github.com/Abhijeet34/pointback/commit/b8865efac33a721145a2221b17b32319eff40873))
* **open:** render each review once and catch CSS url() assets outside the root ([#109](https://github.com/Abhijeet34/pointback/issues/109)) ([7f2265d](https://github.com/Abhijeet34/pointback/commit/7f2265de3d70ee07c99f8056e427445462de5d72))
* **scripts:** apply repo settings through gh api and add dependency-advisory caller ([#110](https://github.com/Abhijeet34/pointback/issues/110)) ([838644a](https://github.com/Abhijeet34/pointback/commit/838644ab135b996b791810f2210d1b3339740cd5))
* **session-store:** number a save made while no daemon ran once the next daemon's tab follows the review ([#133](https://github.com/Abhijeet34/pointback/issues/133)) ([c9db96f](https://github.com/Abhijeet34/pointback/commit/c9db96f98682be1839680674b52b5826f2243789))

## [0.1.7](https://github.com/Abhijeet34/pointback/compare/v0.1.6...v0.1.7) (2026-10-12)


### Bug Fixes

* **browser:** a target the gate drops hands the page back ([#95](https://github.com/Abhijeet34/pointback/issues/95)) ([ed2f167](https://github.com/Abhijeet34/pointback/commit/ed2f167c339034b70316b9c9be82d8ec5f3591ac))
* **browser:** keep a half-typed note in its card when the review closes ([#66](https://github.com/Abhijeet34/pointback/issues/66)) ([5b45b3c](https://github.com/Abhijeet34/pointback/commit/5b45b3c9c5c182ff86743e87a64ba57be5168052))
* **browser:** keep a margin note's focus when the page hears the card close late ([#70](https://github.com/Abhijeet34/pointback/issues/70)) ([4e449de](https://github.com/Abhijeet34/pointback/commit/4e449de3be72b60001f3a854cc824b7adb659b6b))
* **browser:** keep the reading place on pages with a sticky or fixed box ([#65](https://github.com/Abhijeet34/pointback/issues/65)) ([e6b0f38](https://github.com/Abhijeet34/pointback/commit/e6b0f38e9571999065d47281582dbc20e08ba958))
* **browser:** leave nothing focused in the page after a note made by mouse ([#97](https://github.com/Abhijeet34/pointback/issues/97)) ([3a0ed6e](https://github.com/Abhijeet34/pointback/commit/3a0ed6ed5df1e3e575725687e19ef233cb443f36))
* **browser:** recover a refused load of the chrome's own files and the page's stylesheets ([#91](https://github.com/Abhijeet34/pointback/issues/91)) ([50e363a](https://github.com/Abhijeet34/pointback/commit/50e363ac5c5c6086ba60c94d5dddc278f6896705))
* **browser:** recover the chrome from a second refused file after its own reload ([#94](https://github.com/Abhijeet34/pointback/issues/94)) ([30b4867](https://github.com/Abhijeet34/pointback/commit/30b486748669cd3cb1e626b285cf9b94f3e1123e))
* **browser:** recover the review from a refused first load ([#79](https://github.com/Abhijeet34/pointback/issues/79)) ([fc93520](https://github.com/Abhijeet34/pointback/commit/fc93520b0838fb4b57f576f0103af8796d0e0784))
* **browser:** require a proven health answer before the connection counts as live ([#81](https://github.com/Abhijeet34/pointback/issues/81)) ([47f6645](https://github.com/Abhijeet34/pointback/commit/47f6645b0da1856bc3c5957fcdbdde199e127968))
* **browser:** unload a page that has not yet heard the card close ([#86](https://github.com/Abhijeet34/pointback/issues/86)) ([135235b](https://github.com/Abhijeet34/pointback/commit/135235b41e7e346c8ade13f484de5c5b5bb80e1f))
* **browser:** unload a page that takes the keyboard from a note ([#71](https://github.com/Abhijeet34/pointback/issues/71)) ([4b93397](https://github.com/Abhijeet34/pointback/commit/4b9339720a9e3e41142442df1ade7a4f4a5955f3))
* **client:** wait for a concurrent open's daemon while the lock calls it starting ([#89](https://github.com/Abhijeet34/pointback/issues/89)) ([96da8fb](https://github.com/Abhijeet34/pointback/commit/96da8fbd37c1488057ae3c98941afd4468cb6304))
* **cli:** never name a concurrent start's daemon of this version as an older one that did not stop ([#69](https://github.com/Abhijeet34/pointback/issues/69)) ([648edaf](https://github.com/Abhijeet34/pointback/commit/648edaf35c5a1e1e3a2e0e9ca6bb48e52be5fa9b))
* **cli:** never name a just-started daemon of this version as one stop could not stop ([#75](https://github.com/Abhijeet34/pointback/issues/75)) ([8a78d73](https://github.com/Abhijeet34/pointback/commit/8a78d73df386e015ee029bb7bca411f34a754cff))
* **cli:** split long polls into bounded requests so --timeout-ms above 300000 answers ([#63](https://github.com/Abhijeet34/pointback/issues/63)) ([dcd5fa6](https://github.com/Abhijeet34/pointback/commit/dcd5fa603903a4e9e14649faeb5531336aa76f77))
* **cli:** wait for the daemon to exit before reporting stopped ([#74](https://github.com/Abhijeet34/pointback/issues/74)) ([dfca4fd](https://github.com/Abhijeet34/pointback/commit/dfca4fd67cb65e742d2c887839cf39eeb190a3ed))
* **lock:** a probe's timeout no longer counts this process's own stall against the peer ([#90](https://github.com/Abhijeet34/pointback/issues/90)) ([300c6d6](https://github.com/Abhijeet34/pointback/commit/300c6d6ce4d3c0aadd272b5aa5f916844f0f959f))
* **server:** keep idle connections open so a reused add is not dropped ([#77](https://github.com/Abhijeet34/pointback/issues/77)) ([18a4814](https://github.com/Abhijeet34/pointback/commit/18a48140d27bacb4a83bf49a1e422ab72ec0287e))
* **server:** never evict a review that has a tab open ([#60](https://github.com/Abhijeet34/pointback/issues/60)) ([504480c](https://github.com/Abhijeet34/pointback/commit/504480c98478d59f19520a29d4d59300806a5245))
* **server:** run one daemon per state directory and guard session writes ([#62](https://github.com/Abhijeet34/pointback/issues/62)) ([93f404b](https://github.com/Abhijeet34/pointback/commit/93f404b322fb5f8780a36ec7ad8ba166920b715c))

## [0.1.6](https://github.com/Abhijeet34/pointback/compare/v0.1.5...v0.1.6) (2026-10-04)


### Bug Fixes

* **browser:** keep a passage drag from being noted as its whole element ([#58](https://github.com/Abhijeet34/pointback/issues/58)) ([3010270](https://github.com/Abhijeet34/pointback/commit/3010270b84b36b3ea2077561686d42b6342469d9))

## [0.1.5](https://github.com/Abhijeet34/pointback/compare/v0.1.4...v0.1.5) (2026-10-04)


### Features

* **browser:** draw numbered pins, make queued notes editable, start Annotate on ([#43](https://github.com/Abhijeet34/pointback/issues/43)) ([7367015](https://github.com/Abhijeet34/pointback/commit/73670157df8b4e1c86e640ef13b25c3792d6c77e))
* **browser:** point at controls and pictures, block-level Tab stops, review keys, leaner poll ([#44](https://github.com/Abhijeet34/pointback/issues/44)) ([9c71a2d](https://github.com/Abhijeet34/pointback/commit/9c71a2d87e3d0bca180a2f5447c05f6bd3164587))
* **markdown:** render Markdown reviews with house styles and source-line notes ([#48](https://github.com/Abhijeet34/pointback/issues/48)) ([b35371a](https://github.com/Abhijeet34/pointback/commit/b35371ac6ddeaebaaa199a7fc866baf346932d8c))
* **reply:** let the agent answer each note, closing the review loop ([#40](https://github.com/Abhijeet34/pointback/issues/40)) ([ce6caba](https://github.com/Abhijeet34/pointback/commit/ce6cabad07fa2b716d7ee644ce3df4e110bd032c))


### Bug Fixes

* **artifact:** send Access-Control-Allow-Origin on font assets only, so web fonts render in the sandboxed frame ([#39](https://github.com/Abhijeet34/pointback/issues/39)) ([a1bba2b](https://github.com/Abhijeet34/pointback/commit/a1bba2ba0ba3efc105bebcc37f8a223c299ebe0e))
* **browser:** fix pin overlap, add text size control, fix code wrapping ([#52](https://github.com/Abhijeet34/pointback/issues/52)) ([52c43cd](https://github.com/Abhijeet34/pointback/commit/52c43cd820e8d8985702ee2f7b80f4c3be63eccd))
* **browser:** fix reviewer-visible chrome defects in pins, working state, and stray frames ([#49](https://github.com/Abhijeet34/pointback/issues/49)) ([ee814dd](https://github.com/Abhijeet34/pointback/commit/ee814dd18cef4ae261fffdf67a535959fa0f2a9f))
* **browser:** move review chrome onto house design system ([#46](https://github.com/Abhijeet34/pointback/issues/46)) ([35d15b8](https://github.com/Abhijeet34/pointback/commit/35d15b89226510430cb2fc624715fb7875c72f32))
* **browser:** require the reviewer's own gesture inside the page for card and send actions ([#54](https://github.com/Abhijeet34/pointback/issues/54)) ([daf6bf2](https://github.com/Abhijeet34/pointback/commit/daf6bf20ad6c2bbaecef7456fab1f5a9d3c115c4))
* **browser:** stop refetching the session on send/end so a reply can't be lost in the race ([#47](https://github.com/Abhijeet34/pointback/issues/47)) ([0fdf05d](https://github.com/Abhijeet34/pointback/commit/0fdf05d1c578c7d87d1aac3a403e0120d2512e1e))
* **browser:** stream review events over a WebSocket and clarify offline and spent states ([#55](https://github.com/Abhijeet34/pointback/issues/55)) ([f22a1ee](https://github.com/Abhijeet34/pointback/commit/f22a1eee432fa79854c87be193538be183768bae))
* **cli:** keep uids unique across eviction and fix reply/poll error handling ([#53](https://github.com/Abhijeet34/pointback/issues/53)) ([0677636](https://github.com/Abhijeet34/pointback/commit/0677636dfba427b1bb777de6de758d53bf5d068b))
* **cli:** resolve assets within a named --root, not just the file's folder ([#38](https://github.com/Abhijeet34/pointback/issues/38)) ([0552069](https://github.com/Abhijeet34/pointback/commit/0552069d3a7d54bbb3ffca230282ec4c2c15014b))
* **delivery:** key poll cursors by canonical path and session epoch, answer gone for a moved file ([#33](https://github.com/Abhijeet34/pointback/issues/33)) ([5fc0831](https://github.com/Abhijeet34/pointback/commit/5fc0831625886826fd5088ea2cd0694ed796ab23))
* **durability:** keep unsent notes on the server and reconnect tabs across restarts ([#37](https://github.com/Abhijeet34/pointback/issues/37)) ([a4e6de6](https://github.com/Abhijeet34/pointback/commit/a4e6de6249334fb08d95f414005447777b113e7f))
* **events:** resync a tab after a moved file returns or its root changes ([#45](https://github.com/Abhijeet34/pointback/issues/45)) ([0936d5a](https://github.com/Abhijeet34/pointback/commit/0936d5a00d97bbb9834df3ee88fd27c5eaddd5b0))
* **state:** keep one state file per session, splitting the old state.json once ([#42](https://github.com/Abhijeet34/pointback/issues/42)) ([7e1e8f8](https://github.com/Abhijeet34/pointback/commit/7e1e8f845347a8e718ee4600e0b9e8ca8a885b63))

## [0.1.4](https://github.com/Abhijeet34/pointback/compare/v0.1.3...v0.1.4) (2026-10-02)


### Bug Fixes

* **browser:** stop a reviewed page from forging or re-triggering a note ([#32](https://github.com/Abhijeet34/pointback/issues/32)) ([a3c3e30](https://github.com/Abhijeet34/pointback/commit/a3c3e307f7762fd75df91744760dcfd9798e7cd4))
* **chrome:** paint the review chrome with house roles, fix hidden notice and ended switch ([#31](https://github.com/Abhijeet34/pointback/issues/31)) ([20e7a94](https://github.com/Abhijeet34/pointback/commit/20e7a94aee3929e2565bb58f6910e1b5d043d31b))

## [0.1.3](https://github.com/Abhijeet34/pointback/compare/v0.1.2...v0.1.3) (2026-09-04)


### Bug Fixes

* close windows rename race and report daemon startup failures ([#20](https://github.com/Abhijeet34/pointback/issues/20)) ([d64c28c](https://github.com/Abhijeet34/pointback/commit/d64c28ccefb9e49cd2ea185507e5017f5c11a436))

## [0.1.2](https://github.com/Abhijeet34/pointback/compare/v0.1.1...v0.1.2) (2026-09-04)


### Bug Fixes

* **npm:** make pointback's first publish package-page and manifest correct ([#17](https://github.com/Abhijeet34/pointback/issues/17)) ([87cf346](https://github.com/Abhijeet34/pointback/commit/87cf3465ea66807240be127e92949215cdbc6361))

## [0.1.1](https://github.com/Abhijeet34/pointback/compare/v0.1.0...v0.1.1) (2026-09-04)


### Features

* **browser:** give pointback's review chrome a brand identity and presence copy ([#7](https://github.com/Abhijeet34/pointback/issues/7)) ([92835ab](https://github.com/Abhijeet34/pointback/commit/92835ab5ec15c9223bb33981a614a4ab5521bfa7))


### Bug Fixes

* **ci:** resolve browsers per-platform and stop silent CI skips ([#9](https://github.com/Abhijeet34/pointback/issues/9)) ([ac65171](https://github.com/Abhijeet34/pointback/commit/ac65171431178941e124b7c9ae651b8661c99011))
* close three pointback session-integrity gaps ([#11](https://github.com/Abhijeet34/pointback/issues/11)) ([1ee5712](https://github.com/Abhijeet34/pointback/commit/1ee5712e50d635262d1f05a08392eda57a91b500))
* fix six defects found in a live first-run review ([#8](https://github.com/Abhijeet34/pointback/issues/8)) ([837905a](https://github.com/Abhijeet34/pointback/commit/837905ad9dfdd98ccd89fa69f11b8def46e67a89))
* **release:** approve the release pull request's parked CI and gate the tag on all three platforms ([#14](https://github.com/Abhijeet34/pointback/issues/14)) ([60b401b](https://github.com/Abhijeet34/pointback/commit/60b401b6015fac80fe5f62e0b4328bad374ab092))
* **state-dir:** make pointback work on Windows ([#12](https://github.com/Abhijeet34/pointback/issues/12)) ([c009bcc](https://github.com/Abhijeet34/pointback/commit/c009bcc55d9d1badb70d7fef510e0e60973be533))

## 0.1.0 (2026-09-03)


### Features

* **browser:** point at a passage or a table cell, by mouse or by keyboard ([4a2be4b](https://github.com/Abhijeet34/pointback/commit/4a2be4b88390619b855ff13b0684245c61b558af))
* **chrome:** live reload, presence, handover notice and a confirmed end ([7e5c50e](https://github.com/Abhijeet34/pointback/commit/7e5c50e2d7c30ef1b639aa9bdc381e21a378be72))
* foundation and the annotate-to-poll vertical slice ([5adf902](https://github.com/Abhijeet34/pointback/commit/5adf902d10a5a254aeb05bdf19c0bf18e4d44fc1))
* **license:** add Apache-2.0 licence, security policy, and drop stale identity claims ([#5](https://github.com/Abhijeet34/pointback/issues/5)) ([69b63f0](https://github.com/Abhijeet34/pointback/commit/69b63f0173d9c47f3f93f0acb21a7ba02d26a3ca))
* release pipeline, gated publishing and the tag guard ([45cb16a](https://github.com/Abhijeet34/pointback/commit/45cb16a53ea246fc2541eea572a68aebdfeaee1a))
* **server:** ndjson event stream with supersede and cap, end and reopen routes ([a95ae5d](https://github.com/Abhijeet34/pointback/commit/a95ae5dd359957683acac0d728139e2a21d79aba))
* **targeting:** validated anchors and a bounded page outline reach the agent ([7216dac](https://github.com/Abhijeet34/pointback/commit/7216dac076d8a797ef2c7bb666416e2bc98bd486))


### Bug Fixes

* **browser:** acknowledge the annotate toggle so a click cannot outrun it ([2201fb5](https://github.com/Abhijeet34/pointback/commit/2201fb5714c57d0e46eb66ed20f0c6d27980d73f))
* **release:** let a release pull request pass its own checks ([#6](https://github.com/Abhijeet34/pointback/issues/6)) ([bf45dab](https://github.com/Abhijeet34/pointback/commit/bf45daba0fde32b62b3c3375cdf66b78c971f80f))
* **release:** start pointback at 0.1.0 and make release gates enforceable ([#1](https://github.com/Abhijeet34/pointback/issues/1)) ([56a4e51](https://github.com/Abhijeet34/pointback/commit/56a4e519ad99baceb95956c759f62d8608e52f3a))
* **server:** a tab that vanishes mid-write closes its stream instead of killing the daemon ([cbcda63](https://github.com/Abhijeet34/pointback/commit/cbcda63e21bb2e8e0099b2ab60838f41ed4ef00e))
* **store:** an ended session keeps no working agent, and a reopen announces itself ([1d27296](https://github.com/Abhijeet34/pointback/commit/1d2729642f644022bbaf1c7b26baf2cbc7777a47))
