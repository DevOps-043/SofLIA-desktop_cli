import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { prepareTemplateEntryPoint } from '../template-build.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-template-build-'));
  await fsp.mkdir(path.join(tempDir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(tempDir, 'src', 'index.tsx'), 'export default function Template() { return null; }');
});

afterEach(async () => {
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('prepareTemplateEntryPoint', () => {
  it('wraps component templates with a Remotion root entrypoint', async () => {
    const entryPoint = await prepareTemplateEntryPoint(tempDir, {
      entryPoint: 'src/index.tsx',
      compositionId: 'component-template',
      exportMode: 'component',
      defaultDurationFrames: 120,
      fps: 30,
      width: 1280,
      height: 720,
      defaultProps: { title: 'Demo' },
    }, 'fallback-composition');

    assert.equal(entryPoint, path.join(tempDir, '.soflia-worker-entry.tsx'));
    const wrapper = await fsp.readFile(entryPoint, 'utf8');
    assert.match(wrapper, /registerRoot\(SofliaTemplateRoot\)/);
    assert.match(wrapper, /id="component-template"/);
    assert.match(wrapper, /durationInFrames=\{120\}/);
    assert.match(wrapper, /import \* as TemplateModule from "\.\/src\/index"/);
  });

  it('uses root templates directly', async () => {
    const entryPoint = await prepareTemplateEntryPoint(tempDir, {
      entryPoint: 'src/index.tsx',
      exportMode: 'root',
    }, 'root-template');

    assert.equal(entryPoint, path.join(tempDir, 'src', 'index.tsx'));
  });

  it('rejects entrypoints outside the extracted bundle', async () => {
    await assert.rejects(
      () => prepareTemplateEntryPoint(tempDir, {
        entryPoint: '../outside.tsx',
        exportMode: 'component',
      }, 'unsafe-template'),
      /Entry point inseguro/,
    );
  });
});
