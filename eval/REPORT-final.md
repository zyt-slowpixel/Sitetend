# Sitetend evaluation report

2 result file(s), 12 configuration(s).

| Configuration | Runs | Pass rate (mean ± sd) | Card precision | Recall | False alarms | Tokens / case | Seconds / case (mean, p95) |
|---|---|---|---|---|---|---|---|
| gpt-5.6-terra · reviewer on · set v1 | 2 | 100.0% ± 0.0 | 100.0% (14/14) | 100.0% | 0.0% (0/16) | 3,684 | 2.5, 5.4 |
| gpt-5.6-terra · reviewer on · set hard | 2 | 94.4% ± 0.0 | 90.9% (20/22) | 100.0% | 0.0% (0/22) | 4,366 | 3.8, 18.0 |
| gpt-5.6-terra · reviewer on · set academic | 2 | 96.2% ± 5.4 | 100.0% (11/11) | 91.7% | 0.0% (0/14) | 3,374 | 2.4, 3.8 |
| gpt-5.6-terra · reviewer on · set multi | 2 | 100.0% ± 0.0 | 100.0% (106/106) | 100.0% | 0.0% (0/70) | 8,003 | 3.2, 6.2 |
| gpt-5.6-terra · reviewer on · set items | 2 | 98.0% ± 2.8 | 100.0% (6/6) | 96.4% | 0.0% (0/22) | 4,740 | 2.9, 5.8 |
| gpt-5.6-terra · reviewer on · set ext2 | 2 | 100.0% ± 0.0 | 100.0% (28/28) | 100.0% | 0.0% (0/28) | 36,873 | 4.0, 6.9 |
| gpt-5.6-terra · reviewer on · set ext3 | 2 | 100.0% ± 0.0 | 100.0% (20/20) | 100.0% | 0.0% (0/20) | 15,624 | 3.4, 5.5 |
| gpt-5.6-terra · reviewer on · set ext4 | 2 | 97.1% ± 4.2 | 92.3% (24/26) | 100.0% | 7.1% (1/14) | 22,912 | 4.2, 8.3 |
| gpt-5.6-terra · reviewer on · set ext5 | 2 | 100.0% ± 0.0 | 100.0% (22/22) | 100.0% | 0.0% (0/16) | 3,864 | 2.9, 4.4 |
| gpt-5.6-terra · reviewer on · set ext6 | 2 | 97.5% ± 3.5 | 95.5% (21/22) | 100.0% | 0.0% (0/18) | 8,946 | 4.3, 9.2 |
| gpt-5.6-terra · reviewer on · set ext7 | 2 | 100.0% ± 0.0 | 100.0% (34/34) | 100.0% | 0.0% (0/26) | 10,169 | 3.8, 8.4 |
| gpt-5.6-terra · reviewer on · all 11 sets | 2 | 99.0% ± 0.5 | 98.4% (306/311) | 99.4% | 0.4% (1/266) | 11,245 | 3.4, 6.5 |

Card precision: suggestions judged right ÷ suggestions that could be judged. Recall: cases expecting a change where it was suggested. False alarms: cases expecting no change that got an unflagged suggestion. A flagged card (the reviewer asks you to double-check) is not counted as a false alarm.

## gpt-5.6-terra · reviewer on · set v1

- Run 1 (2026-11-14 00:21): 15/15
- Run 2 (2026-11-14 00:38): 15/15

By category: should-update 12/12 · should-ignore 8/8 · contradictory 6/6 · manual-conflict 4/4

## gpt-5.6-terra · reviewer on · set hard

- Run 1 (2026-11-14 00:21): 17/18
- Run 2 (2026-11-14 00:38): 17/18

Never passes:
- hard · 新简历：换了工作和更新日期

By category: update+ 8/10 · ignore+ 12/12 · trap 8/8 · precision 6/6

## gpt-5.6-terra · reviewer on · set academic

- Run 1 (2026-11-14 00:21): 12/13
- Run 2 (2026-11-14 00:38): 13/13

Passes only sometimes:
- academic · 课程学期顺延 (1/2)

By category: a-update 11/12 · a-ignore 6/6 · a-trap 8/8

## gpt-5.6-terra · reviewer on · set multi

- Run 1 (2026-11-14 00:21): 85/85
- Run 2 (2026-11-14 00:38): 85/85

By category: m-update 98/98 · m-ignore 38/38 · m-trap 34/34

## gpt-5.6-terra · reviewer on · set items

- Run 1 (2026-11-14 00:21): 25/25
- Run 2 (2026-11-14 00:38): 24/25

Passes only sometimes:
- items · Jekyll 学术模板：新演讲（新建文件） (1/2)

By category: i-add 19/20 · i-neg 12/12 · i-people 6/6 · i-private 12/12

## gpt-5.6-terra · reviewer on · set ext2

- Run 1 (2026-11-14 00:21): 28/28
- Run 2 (2026-11-14 00:38): 28/28

By category: x-update 28/28 · x-trap 14/14 · x-ignore 14/14

## gpt-5.6-terra · reviewer on · set ext3

- Run 1 (2026-11-14 00:21): 20/20
- Run 2 (2026-11-14 00:38): 20/20

By category: f-update 20/20 · f-trap 10/10 · f-ignore 10/10

## gpt-5.6-terra · reviewer on · set ext4

- Run 1 (2026-11-14 00:21): 17/17
- Run 2 (2026-11-14 00:38): 16/17

Passes only sometimes:
- ext4 · 难·al-folio：同一份资料里两个不同的单位 (1/2)

By category: h-mixed 8/8 · h-same 4/4 · h-file 6/6 · h-item 6/6 · h-lang 2/2 · h-trap 5/6 · h-format 2/2

## gpt-5.6-terra · reviewer on · set ext5

- Run 1 (2026-11-14 00:21): 20/20
- Run 2 (2026-11-14 00:38): 20/20

By category: g-update 22/22 · g-trap 10/10 · g-ignore 6/6 · g-item 2/2

## gpt-5.6-terra · reviewer on · set ext6

- Run 1 (2026-11-14 00:21): 20/20
- Run 2 (2026-11-14 00:38): 19/20

Passes only sometimes:
- ext6 · GitHub 主页：新项目 (1/2)

By category: g-update 21/22 · g-trap 10/10 · g-ignore 8/8

## gpt-5.6-terra · reviewer on · set ext7

- Run 1 (2026-11-14 00:21): 30/30
- Run 2 (2026-11-14 00:38): 30/30

By category: g-update 34/34 · g-trap 16/16 · g-ignore 10/10

## gpt-5.6-terra · reviewer on · all 11 sets

- Run 1 (2026-11-14 00:21): 289/291
- Run 2 (2026-11-14 00:38): 287/291

Passes only sometimes:
- academic · 课程学期顺延 (1/2)
- items · Jekyll 学术模板：新演讲（新建文件） (1/2)
- ext4 · 难·al-folio：同一份资料里两个不同的单位 (1/2)
- ext6 · GitHub 主页：新项目 (1/2)

Never passes:
- hard · 新简历：换了工作和更新日期

By category: should-update 12/12 · should-ignore 8/8 · contradictory 6/6 · manual-conflict 4/4 · update+ 8/10 · ignore+ 12/12 · trap 8/8 · precision 6/6 · a-update 11/12 · a-ignore 6/6 · a-trap 8/8 · m-update 98/98 · m-ignore 38/38 · m-trap 34/34 · i-add 19/20 · i-neg 12/12 · i-people 6/6 · i-private 12/12 · x-update 28/28 · x-trap 14/14 · x-ignore 14/14 · f-update 20/20 · f-trap 10/10 · f-ignore 10/10 · h-mixed 8/8 · h-same 4/4 · h-file 6/6 · h-item 6/6 · h-lang 2/2 · h-trap 5/6 · h-format 2/2 · g-update 77/78 · g-trap 36/36 · g-ignore 24/24 · g-item 2/2


## Cost

Estimated from the token counts at the prices given to eval.mjs (default: gpt-5.6-terra gpt-5.6-terra, $2 input and $12 output per 1M tokens).

- 2026-11-14 00:21 · gpt-5.6-terra · reviewer on · set all: $7.08
- 2026-11-14 00:38 · gpt-5.6-terra · reviewer on · set all: $7.10
