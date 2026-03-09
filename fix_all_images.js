const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf-8');

fetch('https://unsplash.com/napi/search/photos?query=modern%20architecture&per_page=50')
  .then(r => r.json())
  .then(data => {
      const unsplashUrls = data.results.map(r => r.urls.raw + '&w=800&q=80');
      let imgIdx = 18; // Start from 18 to use the rest of the 50 images
      
      html = html.replace(/"image":\s*"([^"]*wikimedia\.org[^"]*)"/g, (match, url) => {
          const newUrl = unsplashUrls[imgIdx % unsplashUrls.length];
          imgIdx++;
          return `"image": "${newUrl}"`;
      });
      fs.writeFileSync('index.html', html);
      console.log('Replaced remaining wikimedia images! Replacements made: ' + (imgIdx - 18));
  }).catch(e => console.error(e));
