# Third-party files in contracts/res

## outlayer_contract.wasm

OutLayer's NEAR contract, used only by the sandbox integration tests
(`contracts/tests`), where the test account is OutLayer's operator and plays
the worker. Fairground never deploys it anywhere else.

- Source: https://github.com/out-layer/outlayer (formerly fastnear/near-outlayer),
  file `contract/res/local/outlayer_contract.wasm` at commit
  `3079d756a0be19e09d1c81f52336528d2603c11b` (8 Nov 2026). Copied unmodified.
- sha256: `74ab074a27ccddd9b6f400f3f8453c1039419acba556ba77dfb288759b3dbd0f`
  (782,118 bytes). Its base58 form, `8rRYysyHSZYxef6ke6XPe6yvGCLyGSsrqn8R8wzfeULn`,
  is the code hash deployed on `outlayer.testnet` and `outlayer.near` on 9 Nov 2026.
- License: Apache License 2.0 (the repository's `LICENSING.md` lists `contract/`
  as Apache-2.0). Copyright 2025-2026 OutLayer, Inc.

The upstream NOTICE file reads:

```
OutLayer
Copyright 2025-2026 OutLayer, Inc.

This product includes software developed by OutLayer, Inc.
(https://outlayer.ai/).

Portions of this product are derived from the NEAR MPC contract
(https://github.com/near/mpc), Copyright (c) NEAR Protocol contributors,
licensed under the MIT License. See register-contract/NOTICE for details.

This product bundles or depends on third-party software under separate
licenses. A complete inventory, including the licenses elected for
dual-licensed dependencies and the GPL components present in published
container images, is in THIRD_PARTY_LICENSES.md.
```

A copy of the license is in `LICENSE-APACHE-2.0` next to this file: the
repository's root `LICENSE` at the same commit, copied unmodified (sha256
`3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5`). It is
also at https://www.apache.org/licenses/LICENSE-2.0.
