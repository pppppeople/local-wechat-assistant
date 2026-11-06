'use strict';

// Feature producers decide the outcome at the branch that applies or refuses
// the operation. Display wording must never decide whether a task succeeded.
function changed(reply) { return { reply, wrote: true, continue: true }; }
function refused(reply) { return { reply, wrote: false, continue: false }; }
function unchanged(reply) { return { reply, wrote: false, continue: true }; }
function resultText(result) { return result && typeof result === 'object' ? result.reply : result; }
function readResult(result) { return typeof result === 'string' ? unchanged(result) : result; }

module.exports = { changed, readResult, refused, resultText, unchanged };
