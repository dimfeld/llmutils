#!/bin/bash
hyperfine -w 5 'bun src/rmplan/rmplan.ts list'
