import arg from 'arg';
import { deepCopy } from '../utils/tools';
import { resolve, dirname, join, extname } from 'path';
import { Processor } from '../lib';
import { readFileSync, writeFileSync, watch, unwatchFile, existsSync } from 'fs';
import { HTMLParser, CSSParser } from '../utils/parser';
import { StyleSheet } from '../utils/style';
import {
  getVersion,
  globArray,
  generateTemplate,
  Console,
  fuzzy,
} from './utils';
import type { Extractor } from '../interfaces';

const doc = `Generate css from text files that containing windi classes.
By default, it will use interpretation mode to generate a single css file.

Usage:
  windicss [filenames]
  windicss [filenames] -c -m -w
  windicss [filenames] -c -s -m -w
  windicss [filenames] [-c | -i] [-a] [-b | -s] [-m] [-w] [-p <prefix:string>] [-o <path:string>] [--args arguments]

Options:
  -h, --help            Print this help message and exit.
  -v, --version         Print windicss current version and exit.

  -i, --interpret       Interpretation mode, generate class selectors. This is the default behavior.
  -c, --compile         Compilation mode, combine the class name in each row into a single class.
  -a, --attributify     Attributify mode, generate attribute selectors. Attributify mode can be mixed with the other two modes.
  -t, --preflight       Add preflights, default is false.

  -b, --combine         Combine all css into one single file. This is the default behavior.
  -s, --separate        Generate a separate css file for each input file.

  -m, --minify          Generate minimized css file.
  -w, --watch           Enable watch mode.
  -z, --fuzzy           Enable fuzzy match, only works in interpration mode.
  -p, --prefix PREFIX   Set the css class name prefix, only valid in compilation mode. The default prefix is 'windi-'.
  -o, --output PATH     Set output css file path.
  -f, --config PATH     Set config file path.

  --style               Parse and transform windi style block.
  --init PATH           Start a new project on the path.
`;

const args = arg({
  // Types
  '--help': Boolean,
  '--version': Boolean,
  '--compile': Boolean,
  '--interpret': Boolean,
  '--attributify': Boolean,
  '--preflight': Boolean,
  '--combine': Boolean,
  '--separate': Boolean,
  '--watch': Boolean,
  '--minify': Boolean,
  '--fuzzy': Boolean,
  '--style': Boolean,
  '--init': String,
  '--prefix': String,
  '--output': String,
  '--config': String,

  // Aliases
  '-h': '--help',
  '-v': '--version',
  '-i': '--interpret',
  '-c': '--compile',
  '-a': '--attributify',
  '-t': '--preflight',
  '-b': '--combine',
  '-s': '--separate',
  '-w': '--watch',
  '-m': '--minify',
  '-p': '--prefix',
  '-o': '--output',
  '-f': '--config',
  '-z': '--fuzzy',
});

if (args['--help'] || (args._.length === 0 && Object.keys(args).length === 1)) {
  Console.log(doc);
  process.exit();
}

if (args['--version']) {
  Console.log(getVersion());
  process.exit();
}

if (args['--init']) {
  const template = generateTemplate(args['--init'], args['--output']);
  args._.push(template.html);
  args['--preflight'] = true;
  args['--output'] = template.css;
}

const preflights: { [key:string]: StyleSheet } = {};
const styleSheets: { [key:string]: StyleSheet } = {};
const processor = new Processor(args['--config'] ? require(resolve(args['--config'])) : undefined);

if (args['--config']) Console.log('Config file:', resolve(args['--config']));

function compile(files: string[]) {
  // compilation mode
  const prefix = args['--prefix'] ?? 'windi-';
  files.forEach((file) => {
    let indexStart = 0;
    const outputStyle: StyleSheet[] = [];
    const outputHTML: string[] = [];
    const html = readFileSync(file).toString();
    const parser = new HTMLParser(html);

    // Match ClassName then replace with new ClassName
    parser.parseClasses().forEach((p) => {
      outputHTML.push(html.substring(indexStart, p.start));
      const utility = processor.compile(p.result, prefix, true); // Set third argument to false to hide comments;
      outputStyle.push(utility.styleSheet);
      outputHTML.push([utility.className, ...utility.ignored].join(' '));
      indexStart = p.end;
    });
    outputHTML.push(html.substring(indexStart));
    styleSheets[file] = (
      outputStyle.reduce(
        (previousValue: StyleSheet, currentValue: StyleSheet) =>
          previousValue.extend(currentValue),
        new StyleSheet()
      )
    );

    const outputFile = file.replace(/(?=\.\w+$)/, '.windi');
    writeFileSync(outputFile, outputHTML.join(''));
    Console.log(`${file} -> ${outputFile}`);
    if (args['--preflight']) preflights[file] = processor.preflight(parser.html);
  });
}

function interpret(files: string[]) {
  // interpretation mode
  files.forEach((file) => {
    const content = readFileSync(file).toString();
    let classes: string[] = [];
    if (args['--fuzzy']) {
      classes = fuzzy(content);
    } else {
      const parser = new HTMLParser(content);
      classes = parser.parseClasses().map((i) => i.result);
    }
    const extractors = processor.config('extract.extractors') as Extractor[] | undefined;
    if (extractors) {
      for (const { extractor, extensions } of extractors) {
        if (extensions.includes(extname(file).slice(1))) {
          const result = extractor(content);
          if ('classes' in result && result.classes) {
            classes = [...classes, ...result.classes];
          }
        }
      }
    }
    const utility = processor.interpret(classes.join(' '));
    styleSheets[file] = utility.styleSheet;

    if (args['--preflight']) preflights[file] = processor.preflight(content);
  });
}

function attributify(files: string[]) {
  // attributify mode
  files.forEach((file) => {
    const parser = new HTMLParser(readFileSync(file).toString());
    const attrs: { [key: string]: string | string[] } = parser
      .parseAttrs()
      .reduceRight((a: { [key: string]: string | string[] }, b) => {
        if (b.key === 'class' || b.key === 'className') return a;
        if (b.key in a) {
          a[b.key] = Array.isArray(a[b.key])
            ? Array.isArray(b.value)? [ ...(a[b.key] as string[]), ...b.value ]: [ ...(a[b.key] as string[]), b.value ]
            : [ a[b.key] as string, ...(Array.isArray(b.value) ? b.value : [b.value]) ];
          return a;
        }
        return Object.assign(a, { [b.key]: b.value });
      }, {});
    const utility = processor.attributify(attrs);
    styleSheets[file] = utility.styleSheet;
  });
}

function styleBlock(files: string[]) {
  files.forEach((file) => {
    const content = readFileSync(file).toString();
    const block = content.match(/(?<=<style lang=['"]windi["']>)[\s\S]*(?=<\/style>)/);
    if (block && block.index) {
      const css = content.slice(block.index, block.index + block[0].length);
      const parser = new CSSParser(css, processor);
      styleSheets[file] = styleSheets[file].extend(parser.parse());
    }
  });
}

function build(files: string[], update = false) {
  if (args['--compile']) {
    compile(files);
  } else {
    interpret(files);
  }
  if (args['--attributify']) attributify(files);
  if (args['--style']) styleBlock(files);
  if (args['--separate']) {
    for (const [file, sheet] of Object.entries(styleSheets)) {
      const outfile = file.replace(/\.\w+$/, '.windi.css');
      writeFileSync(outfile, (args['--preflight'] ? deepCopy(sheet).extend(preflights[file], false) : sheet).build(args['--minify']));
      Console.log(`${file} -> ${outfile}`);
    }
  } else {
    let outputStyle = Object.values(styleSheets)
      .reduce(
        (previousValue: StyleSheet, currentValue: StyleSheet) =>
          previousValue.extend(currentValue),
        new StyleSheet()
      )
      .sort()
      .combine();
    if (args['--preflight'])
      outputStyle = Object.values(preflights)
        .reduce(
          (previousValue: StyleSheet, currentValue: StyleSheet) =>
            previousValue.extend(currentValue),
          new StyleSheet()
        )
        .sort()
        .combine()
        .extend(outputStyle);
    const filePath = args['--output'] ?? 'windi.css';
    writeFileSync(filePath, outputStyle.build(args['--minify']));
    if (!update) {
      Console.log('Matched files:', files);
      Console.log('Output file:', resolve(filePath));
    }
  }
}

let matchFiles = globArray(args._);

if (matchFiles.length === 0) {
  Console.error('No files were matched!');
  process.exit();
}

build(matchFiles);

function watchBuild(file: string) {
  watch(file, (event, path) => {
    if (event === 'rename') {
      const newFiles = globArray(args._);
      const renamed = matchFiles.filter(i => !(newFiles.includes(i)))[0];
      if (existsSync(path)) {
        Console.log('File', `'${renamed}'`, 'has been renamed to', `'${path}'`);
        matchFiles = newFiles;
        Console.log('Matched files:', matchFiles);
      } else {
        Console.log('File', `'${file}'`, 'has been deleted');
        unwatchFile(file);
        matchFiles = newFiles;
        delete styleSheets[file];
        delete preflights[file];
        if (matchFiles.length > 0) {
          Console.log('Matched files:', matchFiles);
          Console.time('Building');
        }
        build([], true);
        if (matchFiles.length > 0) {
          Console.timeEnd('Building');
        } else {
          Console.error('No files were matched!');
          process.exit();
        }
      }
    }
    if (event === 'change') {
      Console.log('File', `'${path}'`, 'has been changed');
      Console.time('Building');
      build([file], true);
      Console.timeEnd('Building');
    }
  });
}

if (args['--watch']) {
  for (const file of matchFiles) {
    watchBuild(file);
  }
  for (const dir of Array.from(new Set(matchFiles.map(f => dirname(f))))) {
    watch(dir, (event, path) => {
      if (event === 'rename' && existsSync(join(dir, path))) {
        // when create new file
        const newFiles = globArray(args._);
        if (newFiles.length > matchFiles.length) {
          const newFile = newFiles.filter(i => !matchFiles.includes(i))[0];
          Console.log('New file', `'${newFile}'`,  'added');
          matchFiles.push(newFile);
          Console.log('Matched files:', matchFiles);
          Console.time('Building');
          build([newFile], true);
          watchBuild(newFile);
          Console.timeEnd('Building');
        }
      }
    });
  }
}
