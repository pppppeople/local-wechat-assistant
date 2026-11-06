'use strict';

function parseMultiImageNoteCommand(text) {
  return /^(?:整理成笔记|多图笔记|把这几张图整理成笔记)$/u.test(String(text || '').trim())
    ? { type: 'generate' } : null;
}

module.exports = { parseMultiImageNoteCommand };
