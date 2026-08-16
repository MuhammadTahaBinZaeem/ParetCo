'use strict';

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'ui', 'index.html');
if (fs.existsSync(indexPath)) {
  let source = fs.readFileSync(indexPath, 'utf8');
  const oldText = '  <script src="runtime_fixes.js"></script>';
  const newText = '  <script src="runtime_fixes.js"></script>\n  <script src="round3_runtime.js"></script>';
  if (!source.includes(newText)) {
    if (source.includes(oldText)) {
      source = source.replace(oldText, newText);
      fs.writeFileSync(indexPath, source, 'utf8');
      console.log('[round3-preflight] project I/O runtime enabled.');
    } else {
      console.warn('[round3-preflight] runtime_fixes.js script tag not found.');
    }
  }
}

require('./round2_preflight');
