#!/usr/bin/env bash

set -euo pipefail

mkdir -p public/audio

tmp_file="$(mktemp /tmp/interview.XXXXXX.aiff)"

say -o "$tmp_file" "Welcome to the interview. We will start with a brief introduction and your background. Next we will discuss your backend experience, including APIs and databases. Then we will move to system design and architecture for scalable services. Finally we will wrap up with your questions and next steps."

afconvert -f WAVE -d LEI16 "$tmp_file" public/audio/interview.wav

rm -f "$tmp_file"
