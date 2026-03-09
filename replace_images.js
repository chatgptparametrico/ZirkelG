const fs = require('fs');
const https = require('https');

async function main() {
    try {
        // 1. Get failed URLs
        const results = fs.readFileSync('fetch_results.txt', 'utf-8');
        const failedUrls = results.split('\n')
            .filter(line => line.startsWith('FAILED:'))
            .map(line => line.replace('FAILED: ', '').trim());
            
        console.log(`Found ${failedUrls.length} broken images to replace.`);
        
        // 2. Fetch Unsplash images
        const apiResponse = await fetch('https://unsplash.com/napi/search/photos?query=modern%20architecture&per_page=50');
        const data = await apiResponse.json();
        const unsplashUrls = data.results.map(r => r.urls.raw + '&w=800&q=80'); // Get optimized size
        
        console.log(`Fetched ${unsplashUrls.length} Unsplash images.`);
        
        // 3. Replace in index.html
        let html = fs.readFileSync('index.html', 'utf-8');
        let unImgIndex = 0;
        
        for (const badUrl of failedUrls) {
            if (unImgIndex >= unsplashUrls.length) {
                console.log("Ran out of Unsplash images!");
                break;
            }
            
            // We only want to replace the image URL, not the whole metadata (for now)
            // But we can also change the title/author if we want. Let's just swap the image URL to be safe
            // and maybe append (Unsplash) to the title so we know.
            
            html = html.replace(badUrl, unsplashUrls[unImgIndex]);
            unImgIndex++;
        }
        
        fs.writeFileSync('index.html', html);
        console.log("Successfully replaced broken images in index.html!");
        
    } catch(e) {
        console.error("Error:", e);
    }
}

main();
