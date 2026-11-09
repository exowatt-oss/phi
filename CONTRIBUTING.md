# Contributing to phi

phi is a fork of [Pi](https://github.com/earendil-works/pi), maintained by Exowatt.
Generic Pi changes may be best proposed upstream; phi-specific fixes are welcome here.

Before submitting a change, run `npm ci --ignore-scripts`, `npm run build:offline`,
`npm run check`, and `./test.sh`. Keep test fixtures synthetic and offline. Changes
must retain the upstream MIT attribution and be licensed under MIT.

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO), not a CLA. Sign off commits with `git commit -s`. Opening an issue or PR
is not conditional on previous maintainer approval.
