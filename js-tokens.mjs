// this is a vendored version of js-tokens by Simon Lydell,
// with the following modifications:
//
// - made it an ES6 module.
// - removed JSX-related code flow which is never used by Roadroller.
// - replaced long token names with exported numeric constants.
// - replaced pseudo-tokens like "?NonExpressionParenKeyword" with
//   two-letter abbreviation like "?A" for the sake of size.
//
// Copyright 2014, 2015, 2016, 2017, 2018, 2019, 2020 Simon Lydell
// License: MIT.

const TAG_JS = 1;
const TAG_JSNonExpressionParen = 2;
const TAG_InterpolationInTemplate = 3;

export const TYPE_StringLiteral = 1;
export const TYPE_NoSubstitutionTemplate = 2;
export const TYPE_TemplateHead = 3;
export const TYPE_TemplateMiddle = 4;
export const TYPE_TemplateTail = 5;
export const TYPE_RegularExpressionLiteral = 6;
export const TYPE_MultiLineComment = 7;
export const TYPE_SingleLineComment = 8;
export const TYPE_IdentifierName = 9;
export const TYPE_NumericLiteral = 10;
export const TYPE_Punctuator = 11;
export const TYPE_WhiteSpace = 12;
export const TYPE_LineTerminatorSequence = 13;
export const TYPE_Invalid = 14;

const TOK_ExpressionBraceEnd = "?A";
const TOK_PostfixIncDec = "?B";
const TOK_UnaryIncDec = "?C";
const TOK_InterpolationInTemplate = "?D";
const TOK_NoLineTerminatorHere = "?E";
const TOK_NonExpressionParenEnd = "?F";
const TOK_NonExpressionParenKeyword = "?G";

const RegularExpressionLiteral = /\/(?![*\/])(?:\[(?:(?![\]\\]).|\\.)*\]|(?![\/\]\\]).|\\.)*(\/[$_\u200C\u200D\p{ID_Continue}]*|\\)?/yu;
const Punctuator = /--|\+\+|=>|\.{3}|\??\.(?!\d)|(?:&&|\|\||\?\?|[+\-%&|^]|\*{1,2}|<{1,2}|>{1,3}|!=?|={1,2}|\/(?![\/*]))=?|[?~,:;[\](){}]/y;
const IdentifierName = /(?=[$_\p{ID_Start}\\])(?:[$_\u200C\u200D\p{ID_Continue}]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})+/yu;
const StringLiteral = /(['"])(?:(?!\1)[^\\\n\r]|\\(?:\r\n|[^]))*(\1)?/y;
const NumericLiteral = /(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*)n?|0n|[1-9](?:_?\d)*n|(?:(?:0(?!\d)|0\d*[89]\d*|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|0[0-7]+/y;
const Template = /[`}](?:[^`\\$]|\\[^]|\$(?!\{))*(`|\$\{)?/y;
const WhiteSpace = /[\t\v\f\ufeff\p{Zs}]+/yu;
const LineTerminatorSequence = /\r?\n|[\r\u2028\u2029]/y;
const MultiLineComment = /\/\*(?:[^*]|\*(?!\/))*(\*\/)?/y;
const SingleLineComment = /\/\/.*/y;
// TOK_InterpolationInTemplate, TOK_NoLineTerminatorHere, TOK_NonExpressionParenEnd, TOK_UnaryIncDec
const TokensPrecedingExpression = /^(?:[\/+-]|\.{3}|\?[C-F])?$|[{}([,;<>=*%&|^!~?:]$/;
// TOK_NoLineTerminatorHere, TOK_NonExpressionParenEnd
const TokensNotPrecedingObjectLiteral = /^(?:=>|[;\]){}]|else|\?[EF])?$/;
const KeywordsWithExpressionAfter = /^(?:await|case|default|delete|do|else|instanceof|new|return|throw|typeof|void|yield)$/;
const KeywordsWithNoLineTerminatorAfter = /^(?:return|throw|yield)$/;
const Newline = RegExp(LineTerminatorSequence.source);

export function* jsTokens(input) {
    var braces, firstCodePoint, isExpression, lastIndex, lastSignificantToken, length, match, mode, nextLastIndex, nextLastSignificantToken, parenNesting, postfixIncDec, punctuator, stack;
    ({length} = input);
    lastIndex = 0;
    lastSignificantToken = "";
    stack = [
        {tag: TAG_JS}
    ];
    braces = [];
    parenNesting = 0;
    postfixIncDec = false;
    while (lastIndex < length) {
        mode = stack[stack.length - 1];
        switch (mode.tag) {
            case TAG_JS:
            case TAG_JSNonExpressionParen:
            case TAG_InterpolationInTemplate:
                if (input[lastIndex] === "/" && (TokensPrecedingExpression.test(lastSignificantToken) || KeywordsWithExpressionAfter.test(lastSignificantToken))) {
                    RegularExpressionLiteral.lastIndex = lastIndex;
                    if (match = RegularExpressionLiteral.exec(input)) {
                        lastIndex = RegularExpressionLiteral.lastIndex;
                        lastSignificantToken = match[0];
                        postfixIncDec = true;
                        yield ({
                            type: TYPE_RegularExpressionLiteral,
                            value: match[0],
                            closed: match[1] !== void 0 && match[1] !== "\\"
                        });
                        continue;
                    }
                }
                Punctuator.lastIndex = lastIndex;
                if (match = Punctuator.exec(input)) {
                    punctuator = match[0];
                    nextLastIndex = Punctuator.lastIndex;
                    nextLastSignificantToken = punctuator;
                    switch (punctuator) {
                        case "(":
                            if (lastSignificantToken === TOK_NonExpressionParenKeyword) {
                                stack.push({
                                    tag: TAG_JSNonExpressionParen,
                                    nesting: parenNesting
                                });
                            }
                            parenNesting++;
                            postfixIncDec = false;
                            break;
                        case ")":
                            parenNesting--;
                            postfixIncDec = true;
                            if (mode.tag === TAG_JSNonExpressionParen && parenNesting === mode.nesting) {
                                stack.pop();
                                nextLastSignificantToken = TOK_NonExpressionParenEnd;
                                postfixIncDec = false;
                            }
                            break;
                        case "{":
                            Punctuator.lastIndex = 0;
                            isExpression = !TokensNotPrecedingObjectLiteral.test(lastSignificantToken) && (TokensPrecedingExpression.test(lastSignificantToken) || KeywordsWithExpressionAfter.test(lastSignificantToken));
                            braces.push(isExpression);
                            postfixIncDec = false;
                            break;
                        case "}":
                            if (mode.tag === TAG_InterpolationInTemplate && braces.length === mode.nesting) {
                                Template.lastIndex = lastIndex;
                                match = Template.exec(input);
                                lastIndex = Template.lastIndex;
                                lastSignificantToken = match[0];
                                if (match[1] === "${") {
                                    lastSignificantToken = TOK_InterpolationInTemplate;
                                    postfixIncDec = false;
                                    yield ({
                                        type: TYPE_TemplateMiddle,
                                        value: match[0]
                                    });
                                } else {
                                    stack.pop();
                                    postfixIncDec = true;
                                    yield ({
                                        type: TYPE_TemplateTail,
                                        value: match[0],
                                        closed: match[1] === "`"
                                    });
                                }
                                continue;
                            }
                            postfixIncDec = braces.pop();
                            nextLastSignificantToken = postfixIncDec ? TOK_ExpressionBraceEnd : "}";
                            break;
                        case "]":
                            postfixIncDec = true;
                            break;
                        case "++":
                        case "--":
                            nextLastSignificantToken = postfixIncDec ? TOK_PostfixIncDec : TOK_UnaryIncDec;
                            break;
                        case "<":
                            postfixIncDec = false;
                            break;
                        default:
                            postfixIncDec = false;
                    }
                    lastIndex = nextLastIndex;
                    lastSignificantToken = nextLastSignificantToken;
                    yield ({
                        type: TYPE_Punctuator,
                        value: punctuator
                    });
                    continue;
                }
                IdentifierName.lastIndex = lastIndex;
                if (match = IdentifierName.exec(input)) {
                    lastIndex = IdentifierName.lastIndex;
                    nextLastSignificantToken = match[0];
                    switch (match[0]) {
                        case "for":
                        case "if":
                        case "while":
                        case "with":
                            if (lastSignificantToken !== "." && lastSignificantToken !== "?.") {
                                nextLastSignificantToken = TOK_NonExpressionParenKeyword;
                            }
                    }
                    lastSignificantToken = nextLastSignificantToken;
                    postfixIncDec = !KeywordsWithExpressionAfter.test(match[0]);
                    yield ({
                        type: TYPE_IdentifierName,
                        value: match[0]
                    });
                    continue;
                }
                StringLiteral.lastIndex = lastIndex;
                if (match = StringLiteral.exec(input)) {
                    lastIndex = StringLiteral.lastIndex;
                    lastSignificantToken = match[0];
                    postfixIncDec = true;
                    yield ({
                        type: TYPE_StringLiteral,
                        value: match[0],
                        closed: match[2] !== void 0
                    });
                    continue;
                }
                NumericLiteral.lastIndex = lastIndex;
                if (match = NumericLiteral.exec(input)) {
                    lastIndex = NumericLiteral.lastIndex;
                    lastSignificantToken = match[0];
                    postfixIncDec = true;
                    yield ({
                        type: TYPE_NumericLiteral,
                        value: match[0]
                    });
                    continue;
                }
                Template.lastIndex = lastIndex;
                if (match = Template.exec(input)) {
                    lastIndex = Template.lastIndex;
                    lastSignificantToken = match[0];
                    if (match[1] === "${") {
                        lastSignificantToken = TOK_InterpolationInTemplate;
                        stack.push({
                            tag: TAG_InterpolationInTemplate,
                            nesting: braces.length
                        });
                        postfixIncDec = false;
                        yield ({
                            type: TYPE_TemplateHead,
                            value: match[0]
                        });
                    } else {
                        postfixIncDec = true;
                        yield ({
                            type: TYPE_NoSubstitutionTemplate,
                            value: match[0],
                            closed: match[1] === "`"
                        });
                    }
                    continue;
                }
                break;
        }
        WhiteSpace.lastIndex = lastIndex;
        if (match = WhiteSpace.exec(input)) {
            lastIndex = WhiteSpace.lastIndex;
            yield ({
                type: TYPE_WhiteSpace,
                value: match[0]
            });
            continue;
        }
        LineTerminatorSequence.lastIndex = lastIndex;
        if (match = LineTerminatorSequence.exec(input)) {
            lastIndex = LineTerminatorSequence.lastIndex;
            postfixIncDec = false;
            if (KeywordsWithNoLineTerminatorAfter.test(lastSignificantToken)) {
                lastSignificantToken = TOK_NoLineTerminatorHere;
            }
            yield ({
                type: TYPE_LineTerminatorSequence,
                value: match[0]
            });
            continue;
        }
        MultiLineComment.lastIndex = lastIndex;
        if (match = MultiLineComment.exec(input)) {
            lastIndex = MultiLineComment.lastIndex;
            if (Newline.test(match[0])) {
                postfixIncDec = false;
                if (KeywordsWithNoLineTerminatorAfter.test(lastSignificantToken)) {
                    lastSignificantToken = TOK_NoLineTerminatorHere;
                }
            }
            yield ({
                type: TYPE_MultiLineComment,
                value: match[0],
                closed: match[1] !== void 0
            });
            continue;
        }
        SingleLineComment.lastIndex = lastIndex;
        if (match = SingleLineComment.exec(input)) {
            lastIndex = SingleLineComment.lastIndex;
            postfixIncDec = false;
            yield ({
                type: TYPE_SingleLineComment,
                value: match[0]
            });
            continue;
        }
        firstCodePoint = String.fromCodePoint(input.codePointAt(lastIndex));
        lastIndex += firstCodePoint.length;
        lastSignificantToken = firstCodePoint;
        postfixIncDec = false;
        yield ({
            type: TYPE_Invalid,
            value: firstCodePoint
        });
    }
    return void 0;
}

