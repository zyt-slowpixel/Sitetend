# Third-party website templates used for evaluation

The `ext-*` folders contain unmodified text files from these open-source templates (MIT License). Each folder's
`website/LICENSE` is the template's own license. Only the files that hold words were copied (pages, configuration,
data files; for the HTML templates also the stylesheet and small images). The `sources/` folders (the "materials")
were written for this evaluation to match each template's sample content.

| Folder | Template | Kind | Upstream (commit) |
|---|---|---|---|
| ext-sb-resume | Start Bootstrap — Resume | static HTML | https://github.com/StartBootstrap/startbootstrap-resume (c6fbe5e) |
| ext-sb-agency | Start Bootstrap — Agency | static HTML | https://github.com/StartBootstrap/startbootstrap-agency (b2d5d5c) |
| ext-sb-freelancer | Start Bootstrap — Freelancer | static HTML | https://github.com/StartBootstrap/startbootstrap-freelancer (5bc65b4) |
| ext-sb-creative | Start Bootstrap — Creative | static HTML | https://github.com/StartBootstrap/startbootstrap-creative (b1762d8) |
| ext-jekyll-academicpages | Academic Pages | Jekyll | https://github.com/academicpages/academicpages.github.io (433f982) |
| ext-jekyll-minima | minima | Jekyll | https://github.com/jekyll/minima (4de3223) |
| ext-jekyll-beautiful | Beautiful Jekyll | Jekyll | https://github.com/daattali/beautiful-jekyll (7286eb8) |
| ext-hugo-coder | hugo-coder (exampleSite) | Hugo | https://github.com/luizdepra/hugo-coder (58d956f) |
| ext-hugo-book | hugo-book (exampleSite) | Hugo | https://github.com/alex-shpak/hugo-book (7875ae6) |
| ext-hugo-terminal | hugo-theme-terminal (exampleSite) | Hugo | https://github.com/panr/hugo-theme-terminal (8ef994c) |
| ext2-html-vcard | vCard Personal Portfolio | static HTML | https://github.com/codewithsadee/vcard-personal-portfolio (927f09a) |
| ext2-html-sbpersonal | Start Bootstrap - Personal (built pages from dist/) | static HTML | https://github.com/StartBootstrap/startbootstrap-personal (6a1ebcc) |
| ext2-hugo-papermod | PaperMod (exampleSite branch) | Hugo | https://github.com/adityatelange/hugo-PaperMod (d2d468c) |
| ext2-hugo-profile | hugo-profile (exampleSite) | Hugo | https://github.com/gurusabarish/hugo-profile (5fc40a9) |
| ext2-jekyll-alfolio | al-folio (text files only) | Jekyll | https://github.com/alshedivat/al-folio (8158dd0) |
| ext2-jekyll-now | Jekyll Now | Jekyll | https://github.com/barryclark/jekyll-now (12cb8a2) |
| ext2-jekyll-chirpy | Chirpy starter | Jekyll | https://github.com/cotes2020/chirpy-starter (beffc88) |
| ext3-astro-devportfolio | devportfolio (Astro) | Astro | https://github.com/RyanFitzgerald/devportfolio (852d650) |
| ext3-react-masterportfolio | masterPortfolio (Create React App; large fetched JSON data left out) | React | https://github.com/ashutosh1919/masterPortfolio (33b04a5) |
| ext3-next-tailwindblog | Tailwind Next.js Starter Blog | Next.js | https://github.com/timlrx/tailwind-nextjs-starter-blog (b45bef6) |
| ext5-hexo-starter | hexo-starter | Hexo | https://github.com/hexojs/hexo-starter (c92a415) |
| ext5-eleventy-baseblog | eleventy-base-blog | Eleventy | https://github.com/11ty/eleventy-base-blog (ae47fc5) |
| ext5-eleventy-hpblog | eleventy-high-performance-blog (text files only; third_party/, test/, src/, js/, fonts/, img/ left out) | Eleventy | https://github.com/google/eleventy-high-performance-blog (e72d0c1) |
| ext6-quarto-qtw | qtwAcademic, template_personal (MIT) | Quarto | https://github.com/andreaczhang/qtwAcademic (18de1bb) |
| ext6-quarto-academic | quarto-academic-website-template (MIT; docs/, files/, _freeze/, fonts left out) | Quarto | https://github.com/drganghe/quarto-academic-website-template (22a9998) |
| ext6-gatsby-blog | gatsby-starter-blog (0BSD) | Gatsby | https://github.com/gatsbyjs/gatsby-starter-blog (d750522) |
| ext6-nuxt-portfolio | Nuxt UI portfolio template (MIT; public/hero images left out) | Nuxt | https://github.com/nuxt-ui-templates/portfolio (c95e344) |
| ext7-lovable-glowfolio | ccn-glow-folio, made with Lovable (MIT) | Vite + React + shadcn | https://github.com/harshu64325/ccn-glow-folio (b25eaa2) |
| ext7-bolt-personal | personal-website, made with bolt.new (MIT; kept as is, merge-conflict markers included) | Vite + React | https://github.com/jibanul/personal-website (ffe5d2c) |
| ext7-angular-portfolio | angular-portfolio-app (MIT) | Angular | https://github.com/barbaracalderon/angular-portfolio-app (6abe09b) |
| ext7-flask-mlh | MLH Fellowship project-a-m (MIT) | Flask + Jinja | https://github.com/mlh-fellowship/project-a-m (217b148) |
| ext7-sveltekit-slick | slick-portfolio-svelte-5 (MIT; screenshots left out) | SvelteKit | https://github.com/riadhadrani/slick-portfolio-svelte-5 (47f1e54) |
| ext7-vite-react | Portfolio by Bvqlz (MIT; the profolio/ folder of the repo) | Vite + React | https://github.com/Bvqlz/Portfolio (f9baabb) |

The `ext2-*` folders (added 2026-11-12) follow the same rules; their cases are in `eval/cases-ext2.json` (held-out). The `ext3-*` folders (website projects built with a JavaScript framework) keep only text and code files, no images; their cases are in `eval/cases-ext3.json` (held-out), together with two small framework sites written here (`own-vue-studio`, `own-svelte-band`).

The `ext5-*` folders (added 2026-11-13, Hexo and Eleventy) follow the same rules; their cases are in `eval/cases-ext5.json` (held-out), together with `own-hexo-researcher` and `own-eleventy-designer` written here.

`ext5-hexo-starter` carries no LICENSE file in its folder; see its upstream repository for its terms.

The `own-*` folders were written for this project.
