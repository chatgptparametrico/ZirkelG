const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 8080;

// Ensure data directories exist
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const CONFIGS_DIR = path.join(__dirname, 'data', 'configs');
const TEMP_DIR = path.join(__dirname, 'data', 'temp_extract');
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(CONFIGS_DIR);
fs.ensureDirSync(TEMP_DIR);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// API: Upload Media
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const fileUrl = `/data/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

// API: Save Configuration
app.post('/api/save', async (req, res) => {
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).send('Invalid data.');
    
    const filePath = path.join(CONFIGS_DIR, `${name}.json`);
    try {
        await fs.writeJson(filePath, data, { spaces: 2 });
        res.json({ message: 'Saved successfully' });
    } catch (err) {
        res.status(500).send('Error saving config.');
    }
});

// API: Get Config List
app.get('/api/configs', async (req, res) => {
    try {
        const files = await fs.readdir(CONFIGS_DIR);
        const configs = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        res.json(configs);
    } catch (err) {
        res.status(500).send('Error reading configs.');
    }
});

// API: Load Config
app.get('/api/load/:name', async (req, res) => {
    const filePath = path.join(CONFIGS_DIR, `${req.params.name}.json`);
    try {
        const data = await fs.readJson(filePath);
        res.json(data);
    } catch (err) {
        res.status(404).send('Config not found.');
    }
});

// API: Delete Config
app.delete('/api/delete/:name', async (req, res) => {
    const filePath = path.join(CONFIGS_DIR, `${req.params.name}.json`);
    try {
        if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
            res.json({ message: 'Deleted successfully' });
        } else {
            res.status(404).send('Config not found.');
        }
    } catch (err) {
        res.status(500).send('Error deleting config.');
    }
});

// API: Download ZIP
app.get('/api/download-zip/:name', async (req, res) => {
    const configName = req.params.name;
    const configPath = path.join(CONFIGS_DIR, `${configName}.json`);
    
    console.log(`[ZIP] Request received for: ${configName}`);

    try {
        if (!await fs.pathExists(configPath)) {
            console.error(`[ZIP] Config not found: ${configPath}`);
            return res.status(404).send('Config not found.');
        }

        const archive = archiver('zip', { zlib: { level: 9 } });
        
        // Listen for errors and warnings
        archive.on('warning', function(err) {
            if (err.code === 'ENOENT') {
                console.warn('[ZIP] Warning:', err);
            } else {
                console.error('[ZIP] Error:', err);
                throw err;
            }
        });

        archive.on('error', function(err) {
            console.error('[ZIP] Archiver error:', err);
            res.status(500).send({ error: err.message });
        });

        // Set headers
        res.attachment(`${configName}.zip`);

        // Pipe archive data to the response
        archive.pipe(res);

        console.log(`[ZIP] Adding config file: gallery_config.json`);
        // Add JSON
        archive.file(configPath, { name: 'gallery_config.json' });

        // Read JSON to find used media
        const galleryData = await fs.readJson(configPath);
        const usedFiles = new Set();
        
        if (galleryData.artworks) {
            galleryData.artworks.forEach(art => {
                if (art.image && art.image.startsWith('/data/uploads/')) {
                    usedFiles.add(path.basename(art.image));
                }
            });
        }

        console.log(`[ZIP] Adding ${usedFiles.size} media files...`);

        // Add used media files
        for (const fileName of usedFiles) {
            const filePath = path.join(UPLOADS_DIR, fileName);
            if (await fs.pathExists(filePath)) {
                archive.file(filePath, { name: `media/${fileName}` });
            } else {
                console.warn(`[ZIP] Media file missing: ${filePath}`);
            }
        }

        console.log(`[ZIP] Finalizing archive...`);
        await archive.finalize();
        console.log(`[ZIP] Successfully sent: ${configName}.zip`);

    } catch (err) {
        console.error('[ZIP] Unexpected error:', err);
        if (!res.headersSent) {
            res.status(500).send('Internal Server Error during ZIP generation.');
        }
    }
});

// API: Import ZIP
app.post('/api/import-zip', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const zipPath = req.file.path;
    const extractId = Date.now().toString();
    const extractPath = path.join(TEMP_DIR, extractId);
    
    console.log(`[IMPORT] Processing ZIP: ${req.file.originalname}`);

    try {
        await fs.ensureDir(extractPath);

        // Use system tar for extraction (works for .zip on modern Windows and Unix)
        // Note: Windows tar might need flags but usually works with -xf
        console.log(`[IMPORT] Extracting to: ${extractPath}`);
        await execPromise(`tar -xf "${zipPath}" -C "${extractPath}"`);

        // 1. Process config
        const incomingJsonPath = path.join(extractPath, 'gallery_config.json');
        if (!await fs.pathExists(incomingJsonPath)) {
            throw new Error('El archivo ZIP no contiene gallery_config.json');
        }

        // Rename config based on ZIP name (removing extension)
        const baseName = path.parse(req.file.originalname).name;
        const newConfigPath = path.join(CONFIGS_DIR, `${baseName}.json`);
        
        await fs.move(incomingJsonPath, newConfigPath, { overwrite: true });
        console.log(`[IMPORT] Saved config as: ${baseName}.json`);

        // 2. Process media
        const incomingMediaDir = path.join(extractPath, 'media');
        if (await fs.pathExists(incomingMediaDir)) {
            const files = await fs.readdir(incomingMediaDir);
            for (const file of files) {
                const src = path.join(incomingMediaDir, file);
                const dest = path.join(UPLOADS_DIR, file);
                await fs.move(src, dest, { overwrite: true });
            }
            console.log(`[IMPORT] Extracted ${files.length} media files.`);
        }

        res.json({ message: 'Galería importada correctamente desde ZIP.', name: baseName });

    } catch (err) {
        console.error('[IMPORT] Error:', err);
        res.status(500).send({ error: err.message });
    } finally {
        // Cleanup
        try {
            if (await fs.pathExists(extractPath)) await fs.remove(extractPath);
            if (await fs.pathExists(zipPath)) await fs.remove(zipPath);
        } catch (cleanupErr) {
            console.error('[IMPORT] Cleanup error:', cleanupErr);
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
