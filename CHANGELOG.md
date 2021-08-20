# Changelog

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

