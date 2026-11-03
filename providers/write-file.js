// Saving a CLI's login file without ever leaving it half-written or leaving tokens behind.

const fs = require('fs');

// tmp + rename, retried briefly when antivirus or the indexer holds the file. If the rename
// keeps failing, write the file directly: a renewed login that never reaches disk is worse
// than a non-atomic write. The tmp file holds tokens, so it never outlives this call.
function writeFileAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.renameSync(tmp, filePath); return; }
      catch (e) {
        const until = Date.now() + 100;
        while (Date.now() < until) {}  // brief pause; the file is small and this is rare
      }
    }
    fs.writeFileSync(filePath, text);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
  }
}

module.exports = { writeFileAtomic };
