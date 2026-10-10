import { PlaywrightCrawler, MemoryStorage, Configuration } from 'crawlee';
import { rm } from 'fs/promises';
import { join } from 'path';

/**
 * Runs the Crawlee Playwright scraper for a given URL.
 *
 * Every invocation:
 *  1. Wipes the on-disk `./storage/` directory (belt) so no stale queue files survive.
 *  2. Constructs the crawler with a fresh MemoryStorage via Configuration (suspenders),
 *     ensuring zero cross-run URL-deduplication even inside the same process lifetime.
 *
 * @param {string} startUrl - The initial URL to crawl.
 * @param {number} maxPages - The maximum number of pages to crawl.
 * @returns {Promise<Array<{url: string, title: string, content: string, links: string[]}>>}
 */
export async function runScraper(startUrl, maxPages = 1) {
  const pages = [];

  // Belt: purge any on-disk Crawlee storage left from prior runs
  const storageDir = join(process.cwd(), 'storage');
  try {
    await rm(storageDir, { recursive: true, force: true });
  } catch (_) {
    // Not fatal — continue even if the dir doesn't exist or can't be deleted
  }

  // Suspenders: use volatile MemoryStorage so the in-process queue is always fresh
  const storage = new MemoryStorage({ persistStorage: false });
  const config = new Configuration({ storageClient: storage });

  const crawler = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: maxPages,
      // Disable the session pool — it owns the CookieJar that rejects
      // apex/special-use domains (e.g. example.com → ".example" suffix).
      useSessionPool: false,
      persistCookiesPerSession: false,
      launchContext: {
        launchOptions: {
          headless: true,
        },
      },
      requestHandlerTimeoutSecs: 30,
      maxRequestRetries: 2,

      async requestHandler({ request, page, log }) {
        log.info(`Processing ${request.url}...`);

        await page.waitForLoadState('domcontentloaded');
        const title = await page.title();

        const data = await page.evaluate(() => {
          function cleanNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
              return node.textContent.replace(/\s+/g, ' ');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
              return '';
            }

            const tagName = node.tagName.toLowerCase();

            if ([
              'script', 'style', 'svg', 'iframe', 'noscript', 'nav', 'footer',
              'header', 'aside', 'button', 'input', 'select', 'textarea', 'form',
            ].includes(tagName)) {
              return '';
            }

            let childText = '';
            for (const child of node.childNodes) {
              childText += cleanNode(child);
            }

            const trimmed = childText.trim();
            if (!trimmed) return '';

            switch (tagName) {
              case 'h1': return `\n\n# ${trimmed}\n\n`;
              case 'h2': return `\n\n## ${trimmed}\n\n`;
              case 'h3': return `\n\n### ${trimmed}\n\n`;
              case 'h4': return `\n\n#### ${trimmed}\n\n`;
              case 'p': return `\n\n${trimmed}\n\n`;
              case 'li': return `\n- ${trimmed}`;
              case 'a': {
                const href = node.getAttribute('href');
                return href && href.startsWith('http')
                  ? ` [${trimmed}](${href}) `
                  : ` ${trimmed} `;
              }
              case 'strong':
              case 'b': return ` **${trimmed}** `;
              case 'em':
              case 'i': return ` *${trimmed}* `;
              case 'code': return ` \`${trimmed}\` `;
              case 'pre': return `\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n`;
              case 'tr': return `\n| ${trimmed} |`;
              case 'td':
              case 'th': return ` ${trimmed} |`;
              default: return childText;
            }
          }

          const container =
            document.querySelector('main') ||
            document.querySelector('article') ||
            document.body;

          const markdown = cleanNode(container)
            .replace(/\n\s*\n+/g, '\n\n')
            .trim();

          const links = Array.from(document.querySelectorAll('a'))
            .map((a) => a.href)
            .filter((href) => href && href.startsWith('http'));

          return {
            markdown,
            links: Array.from(new Set(links)),
          };
        });

        pages.push({
          url: request.url,
          title,
          content: data.markdown,
          links: data.links,
        });

        log.info(`Scraped: "${title}" (${data.markdown.length} chars)`);
      },

      failedRequestHandler({ request, log }) {
        log.error(`Extraction failed for: ${request.url}`);
      },
    },
    config, // ← Crawlee v3: pass Configuration as second constructor argument
  );

  await crawler.run([startUrl]);
  return pages;
}
