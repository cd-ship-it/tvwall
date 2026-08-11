const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { getMainDir } = require('../services/playlist');
const { requireAuth } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = getMainDir();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({ storage });
const router = express.Router();

router.use(requireAuth);

// On-site fallback for dropping a file straight into the local media cache
// without waiting on a Drive sync (PRD section 5).
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (field name: "file")' });
  }
  res.json({ ok: true, filename: req.file.filename, size: req.file.size });
});

module.exports = router;
