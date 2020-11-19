# Contributing

### Getting started

Check out the documentation at https://github.com/infinitered/gluegun/tree/master/docs.

```sh
# build
npm run build

# link your new executable
npm link

# and run it!
supabase help

```

### Publishing to NPM

To package your CLI up for NPM, do this:

```shell
$ npm login
$ npm whoami
$ npm lint
$ npm test
(if typescript, run `npm run build` here)
$ npm publish
```
