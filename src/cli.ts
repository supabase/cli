#!/usr/bin/env node

import { build } from 'gluegun'

build('supabase').src(__dirname).create().run()
