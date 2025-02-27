#!/usr/bin/env bash
set -e

cd /root
curl https://sourceware.org/pub/bzip2/bzip2-latest.tar.gz -L -o tmp-bzip2.tar.gz
tar xf tmp-bzip2.tar.gz
cd bzip2*

make libbz2.a
make install PREFIX=/root/build/cache
