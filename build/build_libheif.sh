#!/usr/bin/env bash
set -e

cd /root
curl http://ftp.gnome.org/pub/GNOME/sources/gdk-pixbuf/2.28/gdk-pixbuf-2.28.2.tar.xz -L -o gdk-pixbuf-2.28.2.tar.xz
tar xvfJ gdk-pixbuf-2.28.2.tar.xz
cd gdk-pixbuf-2.28.2
./configure --prefix=/usr --without-libtiff
make
make install

cd /root
curl https://github.com/strukturag/libheif/releases/download/v1.19.5/libheif-1.19.5.tar.gz -L -o tmp-libheif.tar.gz
tar xf tmp-libheif.tar.gz
cd libheif*

cmake --preset=release .

PKG_CONFIG_PATH=/root/build/cache/lib/pkgconfig \

make
make install
