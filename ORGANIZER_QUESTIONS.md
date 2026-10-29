# Questions for the Bobathon organizers

1. Are real company names allowed to be entered in Bob?
2. May company names and search terms be sent to Google News or other public services? (Currently `search_news` sends the company name and search terms to `api.gdeltproject.org`, and `fetch_page`/SEC tools contact the public hosts they read.)
3. What are the Bobcoin limits?
4. Where must the code live, and what is the submission format?
5. Can custom modes be exported and imported?
6. Are government and private entities in scope?
7. May any real client documents be used, and under what written approval?
8. Is any AI disclosure mandatory for submitted artifacts? If so, what is the minimum compliant placement? (The requested profile design shows no disclaimers on the page, so this must be confirmed before changing it.)

## Additional item found during implementation

9. Google News RSS is disallowed for automated access by `https://news.google.com/robots.txt`, so Prep Bob does not use it. The GDELT DOC API is used instead. GDELT covers only about the last three months, returns titles and publishers but no snippets, and rate-limits aggressively (HTTP 429). Is there an approved news source or API (with a key) that the organizers prefer?
