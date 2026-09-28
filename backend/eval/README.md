# Evaluation

`npm run eval:fetch` downloads fixed-seed samples (200 per task) of the TweetEval test sets into `eval/data/`.
`npm run eval` labels them with the configured model through the same code path as the pipeline and writes `eval/results/latest.json`.
`npm run eval -- --check` fails if any metric is below `eval/thresholds.json`.

| Task | Dataset | What is scored |
|---|---|---|
| sentiment | TweetEval sentiment | positive / neutral / negative |
| emotion | TweetEval emotion | anger / joy / optimism / sadness; our excitement→joy, hope→optimism, anxiety→sadness; anything else counts as wrong |
| irony | TweetEval irony | our sarcasm flag |
| stance | TweetEval stance (climate) | favor / against / none toward the stated target |

Baselines: majority class for every task, AFINN lexicon for sentiment.

TweetEval: Barbieri, Camacho-Collados, Espinosa-Anke, Neves. "TweetEval: Unified Benchmark and Comparative Evaluation for Tweet Classification", Findings of EMNLP 2020.
