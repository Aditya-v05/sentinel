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

## Measured (28 Sep 2026, azure/gpt-5.6-terra, reasoning effort low, 200 per task)

| Task | Accuracy | Macro-F1 | Majority | Lexicon |
|---|---|---|---|---|
| sentiment | 0.600 | 0.588 | 0.465 | 0.545 |
| emotion | 0.720 | 0.721 | 0.335 | — |
| irony | 0.945 | 0.944 | 0.570 | — |
| stance | 0.757 | 0.657 | 0.728 | — |

Read honestly: irony and emotion are strong; sentiment on TweetEval's three-way split is only moderately above a dictionary, mostly on the neutral boundary; stance barely beats always answering "none" on a set where most tweets take no stance. These are the numbers the dashboard runs on.
