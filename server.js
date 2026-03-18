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

// Vercel Blob Setup
const { put, list, del } = require('@vercel/blob');
// Note: Vercel provides BLOB_READ_WRITE_TOKEN automatically if linked.
// If running locally, you must provide it in .env or environment variables.
const HAS_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
if (HAS_BLOB) {
    console.log('[SERVER] Vercel Blob integration active.');
} else {
    console.warn('[SERVER] BLOB_READ_WRITE_TOKEN not found. Falling back to local/tmp FS.');
}

// Detection for Vercel / serverless environments
const IS_VERCEL = process.env.VERCEL || process.env.NOW_REGION;
const BASE_DATA_DIR = process.env.APP_DATA_DIR || (IS_VERCEL ? '/tmp' : __dirname);

// Ensure data directories exist
const UPLOADS_DIR = path.join(BASE_DATA_DIR, 'data', 'uploads');
const CONFIGS_DIR = path.join(BASE_DATA_DIR, 'data', 'configs');
const TEMP_DIR = path.join(BASE_DATA_DIR, 'data', 'temp_extract');
const USERS_DB_PATH = path.join(BASE_DATA_DIR, 'data', 'users.json');

// Only run ensureDirSync if we are NOT on Vercel or if it's the /tmp dir
try {
    fs.ensureDirSync(UPLOADS_DIR);
    fs.ensureDirSync(CONFIGS_DIR);
    fs.ensureDirSync(TEMP_DIR);
    
    // Create default simple database if it doesn't exist
    if (!fs.pathExistsSync(USERS_DB_PATH)) {
        fs.writeJsonSync(USERS_DB_PATH, { "admin": "Entheus827$" }, { spaces: 2 });
        console.log('[SERVER] Created default users.json database.');
    }
} catch (e) {
    console.warn('[SERVER] Could not create folders (likely read-only FS):', e.message);
}

app.use(express.json({ limit: '50mb' }));

// CORS and static headers middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    // Enable ranges for video seeking
    res.header('Accept-Ranges', 'bytes');
    next();
});

app.use(express.static(__dirname));
app.use('/data/uploads', express.static(UPLOADS_DIR));

// Diagnostic endpoint
app.get('/api/env', (req, res) => {
    res.json({
        isVercel: !!IS_VERCEL,
        uploadsDir: UPLOADS_DIR,
        configsDir: CONFIGS_DIR,
        nodeVersion: process.version,
        platform: process.platform
    });
});

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
app.post('/api/upload', upload.single('file'), async (req, res) => {
    console.log('[SERVER] Received upload request');
    if (!req.file) {
        console.error('[SERVER] No file in request');
        return res.status(400).send('No file uploaded.');
    }
    
    console.log(`[SERVER] Processing file: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`);

    // Fallback URL (local/tmp)
    let fileUrl = `/data/uploads/${req.file.filename}`;

    if (HAS_BLOB) {
        try {
            console.log('[VERCEL BLOB] Attempting upload...');
            const fileBuffer = await fs.readFile(req.file.path);
            const { url } = await put(`media/${req.file.filename}`, fileBuffer, {
                access: 'public',
                contentType: req.file.mimetype
            });
            fileUrl = url;
            console.log('[VERCEL BLOB] Upload successful:', fileUrl);
        } catch (err) {
            console.error('[VERCEL BLOB] Upload error:', err.message);
            // We still return the local URL as fallback if possible, 
            // but on Vercel this might fail later if /tmp is purged.
        }
    } else {
        console.log('[SERVER] Saved locally to:', fileUrl);
    }

    res.json({ url: fileUrl });
});

// API: Auth
app.post('/api/auth', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Missing credentials' });

    // Vercel Serverless Fallback (In case /tmp FS fails)
    if (username === 'admin' && password === 'Entheus827$') {
        return res.json({ success: true });
    }

    try {
        if (await fs.pathExists(USERS_DB_PATH)) {
            const users = await fs.readJson(USERS_DB_PATH);
            if (users[username] === password) {
                return res.json({ success: true });
            }
        }
    } catch (err) {
        console.error('[SERVER] Auth error:', err.message);
    }
    
    res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// API: Save Configuration
app.post('/api/save', async (req, res) => {
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).send('Invalid data.');
    
    const filePath = path.join(CONFIGS_DIR, `${name}.json`);
    try {
        // Save locally always
        await fs.writeJson(filePath, data, { spaces: 2 });

        if (HAS_BLOB) {
            const jsonString = JSON.stringify(data);
            await put(`configs/${name}.json`, jsonString, {
                access: 'public',
                contentType: 'application/json',
                addRandomSuffix: false // IMPORTANT: Keep stable names for listing
            });
            console.log('[VERCEL BLOB] Saved config:', name);
        }

        res.json({ message: 'Saved successfully' });
    } catch (err) {
        console.error('[SERVER] Save error:', err.message);
        res.status(500).send('Error saving config.');
    }
});

// API: Get Config List
app.get('/api/configs', async (req, res) => {
    try {
        let configs = new Set();
        
        // Try Vercel Blob first
        if (HAS_BLOB) {
            try {
                const { blobs } = await list({ prefix: 'configs/' });
                console.log(`[SERVER] Found ${blobs.length} blobs in configs/`);
                blobs.forEach(b => {
                    // Robust name extraction
                    const name = b.pathname.split('/').pop().replace('.json', '');
                    if (name) configs.add(name);
                });
            } catch (blobErr) {
                console.error('[SERVER] Blob list error:', blobErr.message);
            }
        }

        // Add local files
        if (await fs.pathExists(CONFIGS_DIR)) {
            const files = await fs.readdir(CONFIGS_DIR);
            files.filter(f => f.endsWith('.json')).forEach(f => {
                configs.add(f.replace('.json', ''));
            });
        }

        console.log('[SERVER] Final config list:', [...configs]);
        res.json([...configs]);
    } catch (err) {
        console.error('[SERVER] Read configs error:', err.message);
        res.status(500).send('Error reading configs.');
    }
});

// API: Load Config
app.get('/api/load/:name', async (req, res) => {
    const name = req.params.name;
    try {
        if (HAS_BLOB) {
            const { blobs } = await list({ prefix: `configs/${name}.json` });
            if (blobs.length > 0) {
                const response = await fetch(blobs[0].url);
                const data = await response.json();
                return res.json(data);
            }
        }

        // Fallback to local
        const filePath = path.join(CONFIGS_DIR, `${name}.json`);
        const localData = await fs.readJson(filePath);
        res.json(localData);
    } catch (err) {
        console.error('[SERVER] Load error:', err.message);
        res.status(404).send('Config not found.');
    }
});

// API: Delete Config
app.delete('/api/delete/:name', async (req, res) => {
    const name = req.params.name;
    const filePath = path.join(CONFIGS_DIR, `${name}.json`);
    try {
        let deleted = false;
        
        // Delete local
        if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
            deleted = true;
            console.log('[SERVER] Deleted local config:', name);
        }

        // Delete from Blob
        if (HAS_BLOB) {
            const { blobs } = await list({ prefix: `configs/${name}.json` });
            if (blobs.length > 0) {
                // Delete all matches just in case
                for (const blob of blobs) {
                    await del(blob.url);
                }
                deleted = true;
                console.log('[VERCEL BLOB] Deleted config:', name);
            }
        }

        if (deleted) {
            console.log('[SERVER] Delete successful for:', name);
            res.json({ message: 'Deleted successfully' });
        } else {
            console.warn('[SERVER] Delete failed: No match found for', name);
            res.status(404).send('Configuration non-existent or already deleted.');
        }
    } catch (err) {
        console.error('[SERVER] Delete exception:', err.message);
        res.status(500).send('Error deleting config: ' + err.message);
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
            } else if (HAS_BLOB) {
                // Try to find it in Vercel Blob
                try {
                    const { blobs } = await list({ prefix: `media/${fileName}` });
                    if (blobs.length > 0) {
                        const response = await fetch(blobs[0].url);
                        const buffer = Buffer.from(await response.arrayBuffer());
                        archive.append(buffer, { name: `media/${fileName}` });
                        console.log(`[ZIP] Fetched from Blob: media/${fileName}`);
                    }
                } catch (err) {
                    console.warn(`[ZIP] Failed to fetch media from Blob: ${fileName}`, err.message);
                }
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

        const baseName = path.parse(req.file.originalname).name;
        const newConfigPath = path.join(CONFIGS_DIR, `${baseName}.json`);
        
        // Save locally/tmp
        const configData = await fs.readJson(incomingJsonPath);
        await fs.writeJson(newConfigPath, configData, { spaces: 2 });

        if (HAS_BLOB) {
            await put(`configs/${baseName}.json`, JSON.stringify(configData), {
                access: 'public',
                contentType: 'application/json',
                addRandomSuffix: false
            });
            console.log('[SUPABASE] Import: Saved config to Blob:', baseName);
        }

        // 2. Process media
        const incomingMediaDir = path.join(extractPath, 'media');
        if (await fs.pathExists(incomingMediaDir)) {
            const files = await fs.readdir(incomingMediaDir);
            for (const file of files) {
                const src = path.join(incomingMediaDir, file);
                const dest = path.join(UPLOADS_DIR, file);
                
                // Copy locally
                await fs.copy(src, dest, { overwrite: true });

                if (HAS_BLOB) {
                    const fileBuffer = await fs.readFile(src);
                    await put(`media/${file}`, fileBuffer, {
                        access: 'public',
                        addRandomSuffix: false // Avoid changing filenames from the imported config
                    });
                }
            }
            console.log(`[IMPORT] Extracted and synced ${files.length} media files.`);
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

const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

module.exports = server;
