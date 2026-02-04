#!/bin/bash
hyperfine -w 5 'bun src/tim/tim.ts list'
