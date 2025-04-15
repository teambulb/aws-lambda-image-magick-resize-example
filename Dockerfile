# syntax=docker/dockerfile:1
FROM public.ecr.aws/lambda/nodejs:22

RUN dnf install -y git gcc gcc-c++ cpp cpio make cmake automake autoconf chkconfig clang clang-libs dos2unix zlib zlib-devel zip unzip tar perl libxml2 bzip2 bzip2-libs xz xz-libs pkgconfig libtool

RUN dnf install -y glib2-devel.x86_64 libjpeg-turbo-devel libpng-devel

ADD build /root/build

RUN /root/build/build_libjpeg.sh
RUN /root/build/build_libpng.sh
RUN /root/build/build_libwebp.sh
RUN /root/build/build_libde265.sh
RUN /root/build/build_libheif.sh
RUN /root/build/build_libopenjp2.sh
RUN /root/build/build_libtiff.sh
RUN /root/build/build_libbz2.sh
RUN /root/build/build_lcms.sh
RUN /root/build/build_imagemagick.sh


COPY package.json ${LAMBDA_TASK_ROOT}
COPY package-lock.json ${LAMBDA_TASK_ROOT}
RUN cd ${LAMBDA_TASK_ROOT} && npm i
COPY function.js ${LAMBDA_TASK_ROOT}

# Update the paths to be in the right place
RUN cp /usr/local/lib64/libde265.so* /lib64/ || true && \
    cp /usr/local/lib64/libx265.so* /lib64/ || true
RUN cp /usr/local/lib64/libheif.so* /lib64/

RUN mkdir -p /opt/bin && \
    cp /root/result/bin/magick /opt/bin/magick && \
    if [ -x /opt/bin/magick ]; then \
    echo "magick installed successfully at /opt/bin/magick"; \
    else \
    echo "magick binary not found or not executable at /opt/bin/magick"; \
    exit 1; \
    fi


# Sanity check - can we run magick?
RUN ldd /opt/bin/magick
RUN find / -name 'libheif.so*' && /opt/bin/magick -version

CMD [ "function.handler" ]
