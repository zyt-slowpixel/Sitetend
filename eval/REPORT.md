# Sitetend evaluation report

12 result file(s), 8 configuration(s).

| Configuration | Runs | Pass rate (mean ± sd) | Card precision | Recall | False alarms | Tokens / case | Seconds / case (mean, p95) |
|---|---|---|---|---|---|---|---|
| gpt-5.6-terra · reviewer on · set ext5 | 3 | 100.0% ± 0.0 | 100.0% (33/33) | 100.0% | 0.0% (0/24) | 3,799 | 3.1, 4.5 |
| gpt-5.6-terra · reviewer on · set ext6 | 3 | 100.0% ± 0.0 | 100.0% (33/33) | 100.0% | 0.0% (0/27) | 8,965 | 4.9, 15.0 |
| gpt-5.6-terra · reviewer on · set ext7 | 3 | 93.3% ± 0.0 | 100.0% (45/45) | 88.2% | 0.0% (0/39) | 10,183 | 3.6, 7.3 |
| gpt-5.6-terra · reviewer off · set ext5 | 1 | 100.0% ± 0.0 | 100.0% (11/11) | 100.0% | 0.0% (0/8) | 3,086 | 2.1, 3.4 |
| gpt-5.6-terra · reviewer off · set ext6 | 1 | 100.0% ± 0.0 | 100.0% (11/11) | 100.0% | 0.0% (0/9) | 8,368 | 3.4, 4.6 |
| gpt-5.6-terra · reviewer off · set ext7 | 1 | 93.3% ± 0.0 | 100.0% (15/15) | 88.2% | 0.0% (0/13) | 9,293 | 2.8, 5.7 |
| gpt-5.6-terra · reviewer on · all 3 sets | 3 | 97.1% ± 0.0 | 100.0% (111/111) | 95.0% | 0.0% (0/90) | 8,011 | 3.8, 6.9 |
| gpt-5.6-terra · reviewer off · all 3 sets | 1 | 97.1% ± 0.0 | 100.0% (37/37) | 95.0% | 0.0% (0/30) | 7,255 | 2.7, 5.6 |

Card precision: suggestions judged right ÷ suggestions that could be judged. Recall: cases expecting a change where it was suggested. False alarms: cases expecting no change that got an unflagged suggestion. A flagged card (the reviewer asks you to double-check) is not counted as a false alarm.

## gpt-5.6-terra · reviewer on · set ext5

- Run 1 (2026-11-13 23:16): 20/20
- Run 2 (2026-11-13 23:20): 20/20
- Run 3 (2026-11-13 23:25): 20/20

By category: g-update 33/33 · g-trap 15/15 · g-ignore 9/9 · g-item 3/3

## gpt-5.6-terra · reviewer on · set ext6

- Run 1 (2026-11-13 23:18): 20/20
- Run 2 (2026-11-13 23:22): 20/20
- Run 3 (2026-11-13 23:27): 20/20

By category: g-update 33/33 · g-trap 15/15 · g-ignore 12/12

## gpt-5.6-terra · reviewer on · set ext7

- Run 1 (2026-11-13 23:19): 28/30
- Run 2 (2026-11-13 23:24): 28/30
- Run 3 (2026-11-13 23:29): 28/30

Never passes:
- ext7 · Flask：新爱好
- ext7 · v0：开放日改时间

By category: g-update 45/51 · g-trap 24/24 · g-ignore 15/15

## gpt-5.6-terra · reviewer off · set ext5

- Run 1 (2026-11-13 23:29): 20/20

By category: g-update 11/11 · g-trap 5/5 · g-ignore 3/3 · g-item 1/1

## gpt-5.6-terra · reviewer off · set ext6

- Run 1 (2026-11-13 23:30): 20/20

By category: g-update 11/11 · g-trap 5/5 · g-ignore 4/4

## gpt-5.6-terra · reviewer off · set ext7

- Run 1 (2026-11-13 23:32): 28/30

Never passes:
- ext7 · Flask：新爱好
- ext7 · v0：开放日改时间

By category: g-update 15/17 · g-trap 8/8 · g-ignore 5/5

## gpt-5.6-terra · reviewer on · all 3 sets

- Run 1 (2026-11-13 23:16): 68/70
- Run 2 (2026-11-13 23:20): 68/70
- Run 3 (2026-11-13 23:25): 68/70

Never passes:
- ext7 · Flask：新爱好
- ext7 · v0：开放日改时间

By category: g-update 111/117 · g-trap 54/54 · g-ignore 36/36 · g-item 3/3

## gpt-5.6-terra · reviewer off · all 3 sets

- Run 1 (2026-11-13 23:29): 68/70

Never passes:
- ext7 · Flask：新爱好
- ext7 · v0：开放日改时间

By category: g-update 37/39 · g-trap 18/18 · g-ignore 12/12 · g-item 1/1

