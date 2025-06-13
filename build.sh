#!/bin/bash
bun build --target=bun --compile --production --out=dist/rmplan.js src/rmplan/rmplan.ts
# bun build --target=bun --production --bytecode --outdir=dist src/rmplan/rmplan.ts

