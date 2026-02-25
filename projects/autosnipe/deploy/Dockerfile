FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get -y install \
    xvfb \
    xdotool \
    scrot \
    x11-apps \
    software-properties-common \
    curl \
    && add-apt-repository ppa:mozillateam/ppa \
    && apt-get install -y --no-install-recommends firefox-esr \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

ARG DISPLAY_NUM=1
ARG WIDTH=1024
ARG HEIGHT=768

ENV DISPLAY_NUM=${DISPLAY_NUM}
ENV WIDTH=${WIDTH}
ENV HEIGHT=${HEIGHT}
ENV DISPLAY=:${DISPLAY_NUM}

COPY --chown=browser:browser docker-entrypoint.sh /home/browser/
RUN chmod +x /home/browser/docker-entrypoint.sh

ENTRYPOINT ["/home/browser/docker-entrypoint.sh"]
