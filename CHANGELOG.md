# Changelog

## [0.1.5](https://github.com/Abhijeet34/pointback/compare/v0.1.4...v0.1.5) (2026-10-03)


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
