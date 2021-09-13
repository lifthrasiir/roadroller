# Changelog

## v2.1.0 (2021-09-13)

Compression improvements:

- The compressor now uses a specialized WebAssembly implementation by default. (c2bd4353b1d22407ced62353fe5acffa0ce0487b, d9a38973cece36427e16671fc83ff98d91e0428c)
- Cache the result of JavaScript code transformation during the optimization. Combined with the WebAssembly implementation, the optimization is up to 2.5 times faster than 2.0.0. (02d09a3906a443c6ee6f7edff310a2ac17b06e16)
- Removed a special result by the optimizer for turning JS inputs into texts and made the equivalent a separate option (`-Zdy`). This also allows for using JS-specific modelling for texts if beneficial, and avoids the UI confusion present in the online demo. (14292282e2b926862ca580fde9bca125d559874f)
- The rANS state is now embedded directly into the compressed data. (48ace3df9411840b2417b8ccbe43a09bf9d9e5dc)
- The decoder is now slightly smaller. (819a574c21b4d220f1290299c698c34b25e8bd98, eb746302f8a598bea733111b9ea964882a8f3393, c6a88ee2764f9d00b47561cf35250c63b58ddf27)
- Tools no longer generate a newline between the first and second "lines". (803de3d561a3a93efcc8f6770ead5f90a328d75c)

UI/API improvements:

- `-OO` option is added to the CLI, which runs a series of optimizations forever until a user request. The optimization now proceeds using the best parameters so far when the user has aborted the search with Ctrl-C even in other optimization levels. (17fef015b975868fb761232e9e397aebba976409)
- Renamed `ArrayBufferPool` to `ResourcePool` to allow using it for other uses (e.g. WebAssembly modules). Also made it clear that `ResourcePool.allocate` should not be used outside of Roadroller. (3f073cf451abae9875471dbe1e4915723393162b)
- Packer now creates its own `ResourcePool` if not given, so `Packer.optimize` is now equally fast with or without the pool. (2c727ea5c4aa77ec49b27c3f222be424551fa7de)
- The online demo deallocates the pool a minute after the last compression. (5e86a59e80441db458ff7c4e114d7248d21e5c59)
- `compressWithDefaultModel` has been added as a shortcut (and optimized version) for `compressWithModel` with `DefaultModel`. (1a644e95422b86352eb376605bfa2a8852013ddf)

Bugfixes:

- Fixed a typo in `index.d.ts`. (3f073cf451abae9875471dbe1e4915723393162b)

Deprecations:

- `ArrayBufferPool` and `arrayBufferPool` fields are now deprecated in favor of `ResourcePool` and `resourcePool`. (3f073cf451abae9875471dbe1e4915723393162b)
- `OptimizedPackerOptions.preferTextOverJS` is no longer used and thus deprecated. (14292282e2b926862ca580fde9bca125d559874f)

## v2.0.0 (2021-08-28)

**Breaking Changes:**

- **The first line and second line are no longer guaranteed to be separate statements.** In particular the documentation accidentally suggested that two lines can be (but are not recommended to be) in separate files, necessitating a breaking change.
- `DirectContextModelOptions.modelRecipBaseCount` is now required. The value of 2 is identical to the 1.x behavior.
- Deprecated APIs have been removed.
    - `OptimizerProgressInfo.temperature`: Use `ratio` instead.
    - `optimizeSparseSelectors` function and `Packer.optimizeSparseSelectors` method: Use `Packer.optimize` instad.
    - `PackerOptions.learningRateNum/Denom`: Use `PackerOptions.recipLearningRate` instead.

Compression improvements:

- Added a new tunable `modelRecipBaseCount` parameter (`-Zmd` in the CLI) with a new default, allowing ~3% additional improvements. (4e8041c11457636b6a171e316752af92d4d79614, 207186191cfdb6dfc1251f597b39284ae20dd89c, 717f7eeb294d55c72fb53f5ae31bdbebbf8c59a5)
- The decoder is now slightly smaller. (9cf184518c93005a386895f381ba1ffc6e1b47e3)

UI/API improvements:

- #14: `-O1` is now a quick search that only takes ~10s for typical inputs. The old `-O1` is renamed to `-O2`. (df5c8edb6a803f47dfb3d29c1dc6d5fcba738322)
- The CLI now defaults to `-O1` if no optimizable arguments are given. Use `-O0` to explicitly disable the optimization. (a610f680a3d1e5aabed81368af050ac5271b2a55)
- The estimated compressed size is now more accurate. (8732d3da350b8da58e843921d36fa509fe0737ae)
- The online demo is now slightly more mobile friendly. (10b0bbe6715e36175421c4cac5360148c30fe942)

Bugfixes:

- #7: The output no longer pollutes the global scope by default. New `allowFreeVars` option (`-D` in the CLI) can be used to allow the decoder to be "dirty". (70fae12ee0eeaf754d46e6db78dacd1097f5c5cb, ecd8116c2c0c305334e18fea99b25d9f72b82d5e)
- #15: The optimizer now works in Node.js 14. It is still strongly recommended to use Node.js 16 because 14 is significantly slower. (13d9c8d39740790b5bfcc3b07035a41510aba19f)
- Fixed a bug where `-Zco -M` (but not `-M -Zco`) was incorrectly allowed in the CLI. (ecd8116c2c0c305334e18fea99b25d9f72b82d5e)
- `Packed.freeVars` was missing one variable. (740f2b5eae65b0c033c5f382f49742393d02118a)

## v1.2.1 (2021-08-24)

Compression improvements:

- The context model is now up to 3 times faster than before. This massively improves the optimization performance especially in Firefox. (8af149c105a1eae8f2f29952bffa65670fe76880)

UI/API improvements:

- Now can be used (not exactly "supported", though) with Node.js 14. (d9270c6039f62c994c3444adb84cebed9825fe42)
- The internal API now supports several tools that are necessary to use Roadroller as a general purpose compression library:
    - The preset dictionary can be used now. (3bf784595ae593534f305f80ba00d7763c41e76d)
    - The number of output codes no longer has to be a power of 2; the negative number to `outBits` now denotes the exact code count. (ecb84a358322931dd341aa926a50ee74b59dcf9f)
    - The decompressor can be configured so that it ends at the known final byte instead of the known input length. (d8146d9894ad180123e8d3a3c53e6f3f3071447b)

Bugfixes:

- Fixed the broken JS parser in the online demo. (2bca32cc9c460052ec728494368842323763a526)
- While very unlikely to affect anyone, all uses of Math.log2 have been replaced with the exact function. (b29d3652335a97fd80d581002e1fe3289a5538bf)

## v1.2.0 (2021-08-23)

Compression improvements:

- Default parameters have been meticulously tuned for typical JS code inputs. Up to 5% additional gain in compression has been observed. (2c7a59ab55db5c40fffa92ed62fe7a9ca7bdd59b)
- The optimizer is now able to optimize most internal parameters. (ec7ae89d7ae670b574b2cc4678d570c07a88ceff, e1d1f1bdc4f6242421f5e8620a98bd93d11b975b)
- The decoder is made slightly smaller when compressed. (c06c51063d5b10e592f38ef20606087efd2c9094, 5ca4907e58706ccdf225f58ddb43c159df0917a2)

UI/API improvements:

- The optimization now reports more detailed progress. (86bd800128065494550dfd6708e4e8cb790df810)
- The estimated DEFLATE size now refers to the combined stream size and thus is more accurate. (f7bf1a40ec38ce079612c5ee639e1482131fff34)
- An object returned by `Packer.makeDecoder()` (`Packed`) now includes `estimateLength` method. (bbabf90d61e4faf64b67b1e47140844b5c36452c)
- CLI now supports `-v`, `-vv` etc. (b2b422da6fd1819c11c8188717aeb30b5e02de25)
- CLI and online demo now supports advanced configurations via `-Z...` options. The full list of such options is available with `-h -v`. (95457334843a173ce7b1f117dd6b48a72e4f1ed6)
- The number of contexts can be now configured in the online demo. (5e2d7796bb64aa478a93fe990de7c5163f980e8a)
- CLI now avoids printing backtrace for known classes of errors. (2f6fb1eab9fdc377ff30cf146f926d64470e022f)
- Roadroller can be now imported as a CommonJS module. (a097203689d3960d104bdb764c9f97ecd8487507)

Bugfixes:

- Fixed a bug where `-O1` tried to optimize (and print) parameters, but its compressed output was not using those parameters. (e67e50ec88333a5448df3d58b8f4016563cc1d21, e5fa608d6e9feb7c4d1323690e912d692e8e92ef)
- Fixed a edge case that the data cannot be decompressed if modelMaxCount is 127 or 32767 and an input is long enough that the number is reached. (b22c32c1116f1d099cf370cbb211c0771e61a99f)
- CLI no longer accepts options like `--optimize1` without an in-between `=`. (04ecffa6eaf23af2c7a52667db8047de3b929e87)

Deprecations:

- `Packer.optimizeSparseSelectors` is deprecated in favor of more powerful `Packer.optimize`. (86bd800128065494550dfd6708e4e8cb790df810)
- `PackerOptions.learningRateNum/Denom` is deprecated in favor of a combined `PackerOptions.recipLearningRate`. (e78919ed32a81915bcc62c16cfc0c6f5911e16ed)

## v1.1.0 (2021-08-20)

Compression improvements:

- Re-enabled quote modelling which was there but accidentally got disabled. (19b15aa7c7d1f69a9b45e2ccd61bb987626e9dbc)
- `-O1` tries to use the text type for the JS input if it's worthy. (b99f7e0c94c3e1cbf5b92046061efe9b62e311d5)
- Escaped quotes in string, template (except for the interpolated code) and RegExp literals no longer make the compression worse. (a76330e297eeb67be5fbd9339cc77147d6059810)
- The memory usage is reduced by 40% in the typical settings (precision=16, modelMaxCount=63). (9b1082ec28e869dd501fc62e9990c57590f36b7f)
- The compressor is generally slightly faster due to the model interface change.

UI/API improvements:

- CLI now supports `-q`/`--silent` option. (257a31d812747b23ff709390c77f9608636743b2)
- `-O1` now prints the exact options to replicate the optimization result. (b99f7e0c94c3e1cbf5b92046061efe9b62e311d5)
- `defaultSparseSelectors` now accepts the optional number of contexts. (1cb8542875a97f8a0906d560ceadd93c89e31ad6)

Bugfixes:

- Fixed an invalid code when exactly 1--2, 10 or 33+ abbreviations are in use. (3f60e44b71702c69ae09ca426466933a72a7ad2c, 690c8f3de2fac2d3991d58b5552446fdb48d1b2b)
- Both the compressor and compact decoder now correctly handles more than 64 KB of inputs. (df2f67f70991a9dfff5cca9ec0f245b44c3ca8a7, 3299ba3f10eaac2bb0034e3dd06ad842b927a37c, e4593779766203bb0483625b5631f72a4475967d)
- The compressor no longer fails on very low entropy inputs. (06aad8ab3b8942b6d2facfbe97485009c5e53030)
- Sparse selectors larger than 511 (corresponding to 10th order and beyond) now generate a correct (but less compact) code. (052faef0989c5acb80880cdf33ee9dd0d44744f0)
- `-S` no longer fails with explicit separators. (e73ecced79b09fad5f88cd0cc3ec7b43700c1e03)
- `-a` no longer fails with combined with `-t`. (aab77948db2f1877b160464abd9fe173667ec197)

## v1.0.0 (2021-08-13)

Initial release.

