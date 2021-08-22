# Roadroller: Flattens Your JavaScript Demo

**Roadroller** is a heavyweight JavaScript packer designed for large [demos][demo] of at least 10 KB in size, like [js13kGames]. Depending on the input it can provide up to 10% additional compression compared to [Zopfli]. **[Try it online][online]!**

Roadroller is considered "heavyweight" unlike typical JS packers such as [JSCrush] or [RegPack], because it is quite resource intensive and requires both a considerable amount of memory and a non-negligible run time. The default should work for most devices, but you can configure both aspects as you need.

## Quick Start

In addition to the [online demo][online], Roadroller is available as an [NPM package][npm]:

```
$ npx roadroller input.js -o output.js
```

You can also use Roadroller as a library to integrate with your build pipeline.

```javascript
import { Packer } from 'roadroller';

const inputs = [
    {
        data: 'console.log("Hello, world!");',
        type: 'js',
        action: 'eval',
    },
];

const options = {
    maxMemoryMB: 150,
};

const packer = new Packer(inputs, options);

// this typically takes about a minute or two, can be omitted if you want.
await packer.optimize();

const { firstLine, secondLine } = packer.makeDecoder();
console.log(firstLine + '\n' + secondLine);
```

## Usage

By default Roadroller receives your JS code and returns a compressed JS code that should be further compressed with ZIP/gzip (or more accurately, [DEFLATE]). Ideally your JS code should be already minified, probably using [Terser] or [Closure Compiler]; Roadroller only does a minimal whitespace and comment suppression.

The resulting code will look like this:

```javascript
A='Zos~ZyF_sTdvfgJ^bIq_wJWLGSIz}Chb?rMch}...'
t=12345678;M=1<<17;w=[0,0,0,0,0,0,0,0,0,0,0,0];p=new Uint16Array(12<<21).fill(M/4);/* omitted */;eval(c)
```

The first line is a compressed data. It can contain control characters `` (U+001F) that might not render in certain environments. Nevertheless you should make sure that they are all copied in verbatim.

The second line is a compressor tuned for this particular input. By default the decompressed data immediately goes through `eval`, but you can configure what to do with that.

The first line is very incompressible unlike the second line, so ideally you should compress two lines separately. This is best done by using ADVZIP from [AdvanceCOMP] or the aforementioned Zopfli. It is also possible but not recommended\* to put the first line to a separate file and load it with a separate `<script>` tag.

> \* This is not recommended because any additional file to ZIP incurs at least 88+2n bytes of overhead where n is the length of file name and that overhead mostly negates the additional compression. Instead put everything into a single file and run ADVZIP or Zopfli.

<!--
### Multiple Inputs

You can also give multiple inputs to Roadroller; for example you can put shaders and map data. The executed code will receive all decompressed inputs. This is more efficient than putting them into strings because each input can be separately modelled.
-->

### Input Configuration

Each input can be further configured by input type and action. In the CLI you put corresponding options *before* the file path.

**Input type** (CLI `-t|--type TYPE`, API `type` in the input object) determines the preprocessing step to improve the compression. Dropping a file to the input window also tries to detect the correct input type.

* **JavaScript** (`js`) assumes a valid JS code. Automatically removes all redundant whitespace and comments and enables a separate modelling for embedded strings. This also works for JSON.

<!--* **GLSL** (`glsl`) assumes a valid GLSL code. Automatically removes all redundant whitespace and comments.-->

<!--* **HTML** (`html`) assumes a valid HTML. (TODO)-->

* **Text** (`text`) assumes a human-readable Unicode text that can be encoded in UTF-8. This can also be used for JavaScript code that should not undergo preprocessing.

<!--* **Binary** (`binary`) does nothing. You can choose base64 (`binary:base64`) or hex (`binary:hex`) for the input encoding.-->

**Input action** (CLI `-a|--action ACTION`, API `action` in the input object) determines what to do with the decompressed data. <!--All action except for the evaluate produces a value to the variable named `_` by default, which is either a value itself for a single input and an array of values for multiple inputs.-->

* <!--*(JS, text only)*--> **Evaluate** (`eval`) evaluates the decompressed JavaScript code. If there are multiple inputs there should be exactly one JavaScript input with evaluate action, since subsequent inputs will be decompressed in that code. The resulting value is always a code string, which may include decoders for subsequent inputs.

<!--* *(JS, text only)* **JSON decode** (`json`) parses and returns a JSON value with `JSON.parse`.-->

<!--* *(No binary)* **String** (`string`) returns a string.-->

* <!--*(No binary)*--> **Write to document** (`write`) writes a decompressed string to `document`. Typically used with HTML.

<!--* **Array** (`array`) returns an array of bytes.-->

<!--* **Typed array** (`u8array`) returns a `Uint8Array` value.-->

<!--* **Base64** (`base64`) returns a base64-encoded string. Handy for data URIs.-->

<!--
**Input name** (CLI `-n|--name NAME`, API `name`) is required for accessing each input from the decompressed code. This is required if the input produces an output value.

**Extract inputs** (CLI `-x|--extract`, not available in API) can be used for the JavaScript input with the evaluate action. This will try to extract long embedded strings and determine the best type for each input. This assumes that the compressed code doesn't make use of the output variable elsewhere; you can change the variable name from the configuration.
-->

### Output Configuration

**Number of contexts** (CLI `-S|--selectors xCOUNT`) relates to the complexity of modelling. The larger number of contexts will compress better, but at the expense of linear increase in both the time and memory usage. The default is 12, which targets at most 1 second of latency permitted for typical 30 KB input.

**Optimize contexts** (CLI `-O|--optimize 1`, API `Packer.optimize`) searches for better modelling parameters. If parameters are already given the optimizer will try to improve upon that. Parameters are solely related to the compression ratio so you can try this as many as you can afford.

* The additional argument in the CLI indicates the level of efforts, which can be 0 (do nothing) or 1 (use the default setting, takes about a minute); other values are reserved for the future expansion. The resulting parameters are printed at the end which can be reused for faster iteration.

* While not strictly required, `Packer.optimize` in the API strongly recommends the use of `arrayBufferPool` in the options object. Otherwise the optimization can run slower especially with larger memory. The pool can be created via `new ArrayBufferPool()`.

**Maximum memory usage** (CLI `-M|--max-memory MEGABYTES`, API `maxMemoryMB` in the options object) configures the maximum memory to be used both for compression and decompression. Increasing or decreasing memory usage only affects the compression ratio and not the run time. The actual memory usage can be as low as a half of the specified due to the internal architecture; `-v` will print the actual memory usage to stderr. The default is 150 MB.

### Advanced Configuration

<!--**Output variable name** (CLI `--output-var VAR`) sets the variable name for output values. If the name is empty, it is determined from the input code and typically named `_`. You don't need to change this unless you are doing a weird thing and the code can refer to variables that do not appear in verbatim.-->

**Chosen contexts** (CLI `-S|--selectors SELECTOR,SELECTOR,...`, API `sparseSelectors` in the options object) determine which byte contexts are used for each model. <i>K</i>th bit of the number (where K > 0) is set if the context contains the <i>K</i>th-to-last byte: 5 = 101<sub>(2)</sub> for example would correspond to the context of the last byte and third-to-last byte, also called a sparse context (0,2). There is no particular limit for the number, but Roadroller only considers up to 9th order for the optimization process.

**Precision** (CLI `-Zpr|--precision BITS`, API `precision` in the options object) is the number of fractional bits used in the internal fixed point representation. This is shared between the entropy coder and context models and can't be decoupled. The default of 16 should be enough, you can also try to decrease it.

**Learning rate** (CLI `-Zlr|--learning-rate RATE`, API `recipLearningRate` in the options object) adjusts how fast would the context mixer adapt, where smaller is faster. The default is 500 which should be fine for long enough inputs. If your demo is smaller than 10 KB you can also try smaller numbers.

**Model max count** (CLI `-Zmc|--model-max-count COUNT`, API `modelMaxCount` in the options object) adjusts how fast would individual contexts adapt, where smaller is faster. The model adapts fastest when a particular context is first seen, but that process becomes slower as the context is seen multiple times. This parameter limits how slowest the adaptation process can be. The default of 5 is specifically tuned for JS code inputs.

**Number of abbreviations** (CLI `-Zab|--num-abbreviations NUM`, API `numAbbreviations` in the options object) affects the preprocessing for JS code inputs. Common identifiers and reserved words can be abbreviated to single otherwise unused bytes during the preprocessing; this lessens the burden of context modelling which can only look at the limited number of past bytes. If this parameter is less than the number of allowable abbreviations some identifiers will be left as is, which can sometimes improve the compression.

**Number of context bits** (CLI `-Zco|--context-bits BITS`, API `contextBits` in the options object) sets the size of individual model as opposed to the total memory use (`-M`), which is a product of the number of context and the size of each model. This explicit option is most useful for the fair benchmarking, since some parameters like `-Zpr` or `-Zmc` affect the memory use and therefore this parameter.

<!--**Optimize for uncompressed size** (CLI `--uncompressed-only`) assumes the absence of the outer comperssion algorithm like DEFLATE. This is *bad* for the compression since the compressor has to work strictly within the limits of JS source code including escape sequences. This should be the last resort where you can't even use the PNG-based self extraction and everything has to be in a single file.-->

### Tips and Tricks

* The current algorithm slightly prefers 7-bit and 8-bit inputs for the decoder simplicity. You can still use emojis and other tricks that stuff many bits into Unicode code points, but the compression ratio might be decreased. Keep in mind that Roadroller is already doing the hard work for you and you might not need to repeat that.

* The compressed JS code doesn't do anything beyond computation and the final action, so you can do anything before or after that. The [online demo][online] for example inserts a sort of splash screen as a fallback.

* Roadroller, while being super effective for many inputs, is not a panacea. Roadroller is weaker at exploiting the duplication at a distance than DEFLATE. Make sure to check ADVZIP/Zopfli out.

## Compatibility

Roadroller itself and resulting packed codes are ECMAScript 2015 (ES6) compatible and should run in every modern Web browser and JS implementation. Implementations are assumed to be reasonably fast but otherwise it can run in slower interpreters. MSIE is not directly supported but it works fine (slowly) after simple transpiling.

Roadroller and packed codes extensively use `Math.exp` and `Math.log` that are [implementation-approximated](https://262.ecma-international.org/#implementation-approximated), so there is a small but real possibility that they behave differently in different implementations. This is known to be a non-issue for browser JS engines as well as V8 and node.js as they use the same math library (fdlibm) for those functions, but you have been warned.

By comparison, the Roadroller CLI assumes more from the environment and probably requires Node.js 14 or later (only tested with 16).

## Internals

Roadroller is mostly possible due to the progress in data compression algorithms as recent as 2010s:

* Bytewise [rANS] coder, adapted from Fabien Giesen's [public domain code][ryg_rans].

* [Logistic context mixing], which is a type of neural network specifically designed for the data compression.

* Sparse context models up to 9th order. Models are tuned for each input with simulated annealing. (You may have noticed that this entire architecture is similar to [Crinkler], but Roadroller uses a faster and possibly better parameter search algorithm.)

The minimal JS code for this algorithm was initially adapted from a [golf.horse submission](http://golf.horse/wordlist.asc/contextually-F81hkL3e5HgGOj4bhaSfXIGSI0DSTkb5n58Qqc6NFmc) by Hasegawa Sayuri (public domain). The main difference is that Roadroller implements hashed contexts and thus order 3+ context models.

## License

The Roadroller compressor proper is licensed under the MIT license. In addition to this, any decoder code produced by Roadroller, that is, everything in the second line is put in the public domain.

[npm]: https://www.npmjs.com/package/roadroller
[online]: https://lifthrasiir.github.io/roadroller/

[js13kGames]: https://js13kgames.com/

[Zopfli]: https://github.com/google/zopfli
[JSCrush]: http://www.iteral.com/jscrush/
[RegPack]: https://siorki.github.io/regPack.html
[Terser]: https://terser.org/
[Closure Compiler]: https://closure-compiler.appspot.com/home
[AdvanceCOMP]: http://www.advancemame.it/comp-readme
[Crinkler]: https://github.com/runestubbe/Crinkler
[ryg_rans]: https://github.com/rygorous/ryg_rans/

[demo]: https://en.wikipedia.org/wiki/Demoscene
[DEFLATE]: https://en.wikipedia.org/wiki/Deflate
[Logistic context mixing]: https://en.wikipedia.org/wiki/Context_mixing#Logistic_Mixing
[rANS]: https://en.wikipedia.org/wiki/Asymmetric_numeral_systems#Range_variants_(rANS)_and_streaming

