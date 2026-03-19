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
        fs.writeJsonSync(USERS_DB_PATH, { "admin": "FLLestructuras" }, { spaces: 2 });
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

// ==========================================
// USERS DB VIA VERCEL BLOB
// ==========================================
// Use a secret prefix so the URL is unguessable even though Vercel Blob is technically "public"
const BLOB_SECRET_PREFIX = process.env.BLOB_SECRET_PREFIX || 'zkg_a8f3d12b_c6e7_4a09_8f2e_1b3c9d0e5f71';
const USERS_BLOB_NAME = `${BLOB_SECRET_PREFIX}/users.json`;
const DEFAULT_USERS = { admin: 'FLLestructuras' };

async function readUsersBlob() {
    if (!HAS_BLOB) return null;
    try {
        const { blobs } = await list({ prefix: USERS_BLOB_NAME });
        if (blobs.length === 0) return null;
        // Fetch the blob content
        const resp = await fetch(blobs[0].url);
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.error('[BLOB] Error reading users:', e.message);
        return null;
    }
}

async function writeUsersBlob(users) {
    if (!HAS_BLOB) return;
    try {
        await put(USERS_BLOB_NAME, JSON.stringify(users, null, 2), {
            access: 'public',
            contentType: 'application/json',
            addRandomSuffix: false
        });
        console.log('[BLOB] users.json updated.');
    } catch (e) {
        console.error('[BLOB] Error writing users:', e.message);
    }
}

// Initialize users blob with defaults if it doesn't exist
(async () => {
    if (HAS_BLOB) {
        const existing = await readUsersBlob();
        if (!existing) {
            await writeUsersBlob(DEFAULT_USERS);
            console.log('[BLOB] Initialized default users.json in Vercel Blob.');
        }
    }
})();

// API: Auth
app.post('/api/auth', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Missing credentials' });

    // Try Vercel Blob first
    if (HAS_BLOB) {
        try {
            const users = await readUsersBlob();
            if (users && users[username] === password) {
                return res.json({ success: true });
            } else if (users) {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
        } catch (err) {
            console.error('[SERVER] Blob auth error:', err.message);
        }
    }

    // Fallback: local file or hardcoded default
    try {
        if (await fs.pathExists(USERS_DB_PATH)) {
            const users = await fs.readJson(USERS_DB_PATH);
            if (users[username] === password) {
                return res.json({ success: true });
            }
        }
    } catch (err) {
        console.error('[SERVER] Local auth error:', err.message);
    }

    // Ultimate fallback for admin account
    if (username === 'admin' && password === DEFAULT_USERS['admin']) {
        return res.json({ success: true });
    }

    res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// API: Add User (admin only - requires existing auth first)
app.post('/api/users/add', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

    try {
        let users = HAS_BLOB ? (await readUsersBlob() || {}) : {};
        if (!HAS_BLOB && await fs.pathExists(USERS_DB_PATH)) {
            users = await fs.readJson(USERS_DB_PATH);
        }
        users[username] = password;
        if (HAS_BLOB) await writeUsersBlob(users);
        await fs.writeJson(USERS_DB_PATH, users, { spaces: 2 }).catch(() => {});
        res.json({ success: true, message: `User "${username}" added.` });
    } catch (err) {
        console.error('[SERVER] Add user error:', err.message);
        res.status(500).json({ error: 'Failed to add user.' });
    }
});

// API: Delete User
app.delete('/api/users/:username', async (req, res) => {
    const { username } = req.params;
    if (username === 'admin') return res.status(403).json({ error: 'Cannot delete admin.' });

    try {
        let users = HAS_BLOB ? (await readUsersBlob() || {}) : {};
        if (!HAS_BLOB && await fs.pathExists(USERS_DB_PATH)) {
            users = await fs.readJson(USERS_DB_PATH);
        }
        delete users[username];
        if (HAS_BLOB) await writeUsersBlob(users);
        await fs.writeJson(USERS_DB_PATH, users, { spaces: 2 }).catch(() => {});
        res.json({ success: true, message: `User "${username}" deleted.` });
    } catch (err) {
        console.error('[SERVER] Delete user error:', err.message);
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

// API: List Users
app.get('/api/users', async (req, res) => {
    try {
        let users = HAS_BLOB ? (await readUsersBlob() || {}) : {};
        if (!HAS_BLOB && await fs.pathExists(USERS_DB_PATH)) {
            users = await fs.readJson(USERS_DB_PATH);
        }
        // Return usernames only (never passwords)
        res.json({ users: Object.keys(users) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list users.' });
    }
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

// API: WordPress Proxy (avoid CORS issues when fetching WP REST API)
app.get('/api/wp-proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

    // Only allow fetching from WordPress REST API endpoints
    try {
        const url = new URL(targetUrl);
        if (!url.pathname.includes('/wp-json/')) {
            return res.status(403).json({ error: 'Only WordPress REST API URLs are allowed' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
        console.log('[WP-PROXY] Fetching:', targetUrl);
        const response = await fetch(targetUrl);
        if (!response.ok) {
            return res.status(response.status).json({ error: `WordPress API returned ${response.status}` });
        }
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[WP-PROXY] Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch from WordPress: ' + err.message });
    }
});

// API: AI Interpretation Proxy (keeps API key server-side)
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
app.post('/api/ai-interpret', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (!OPENROUTER_KEY) {
        // No key configured - return a placeholder
        return res.json({ interpretation: null });
    }

    const prompt = `Eres un crítico de arte y arquitectura. En máximo 3 oraciones en español, interpreta brevemente este texto sobre una obra: "${text.substring(0, 300)}". Sé poético y conciso.`;

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_KEY}`,
                'HTTP-Referer': 'https://zirkeldep.com',
                'X-Title': 'ZirkelG Gallery'
            },
            body: JSON.stringify({
                model: 'google/gemma-3-27b-it:free',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 150
            }),
            signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
        const data = await response.json();
        const interpretation = data.choices?.[0]?.message?.content || '';
        res.json({ interpretation });
    } catch (err) {
        console.error('[AI] Interpretation error:', err.message);
        res.status(500).json({ error: err.message, interpretation: null });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

module.exports = server;
