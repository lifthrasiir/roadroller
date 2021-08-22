# Changelog

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

