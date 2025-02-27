import { BuildConfig, panic, run } from './util';
import { execa } from 'execa';
import { join } from 'path';
import { Octokit } from '@octokit/action';
import prompts from 'prompts';
import { readPackageJson, writePackageJson } from './package-json';
import semver from 'semver';
import { validateBuild } from './validate-build';
import { publishCreateQwikCli } from './create-qwik-cli';
import { publishEslint } from './eslint';

export async function setDevVersion(config: BuildConfig) {
  const distTag = config.setDistTag;
  const rootPkg = await readPackageJson(config.rootDir);
  let v = rootPkg.version;
  if (!distTag || distTag === 'dev') {
    const d = new Date();
    v += '-dev';
    v += String(d.getUTCFullYear());
    v += String(d.getUTCMonth() + 1).padStart(2, '0');
    v += String(d.getUTCDate()).padStart(2, '0');
    v += String(d.getUTCHours()).padStart(2, '0');
    v += String(d.getUTCMinutes()).padStart(2, '0');
    v += String(d.getUTCSeconds()).padStart(2, '0');
  }
  config.distVersion = v;
}

export async function setReleaseVersion(config: BuildConfig) {
  const distTag = String(config.setDistTag);
  if (!config.setDistTag || distTag === '') {
    // ensure npm dist tag for an actual release
    panic(`Invalid npm dist tag "${distTag}"`);
  }

  console.log(`💫 Set release npm dist tag: ${distTag}`);

  const rootPkg = await readPackageJson(config.rootDir);
  config.distVersion = rootPkg.version;

  const validVersion = semver.valid(config.distVersion)!;
  if (!validVersion) {
    panic(`Invalid semver version "${config.distVersion}"`);
  }

  console.log(`🔥 Set release npm version: ${config.distVersion}`);

  // check this version isn't already published
  await checkExistingNpmVersion('@builder.io/qwik', config.distVersion);

  const distPkg = await readPackageJson(config.distPkgDir);
  distPkg.version = config.distVersion;
  await writePackageJson(config.distPkgDir, distPkg);
}

export async function prepareReleaseVersion(config: BuildConfig) {
  const rootPkg = await readPackageJson(config.rootDir);

  const answers = await releaseVersionPrompt('@builder.io/qwik', rootPkg.version);
  if (!semver.valid(answers.version)) {
    panic(`Invalid version`);
  }

  config.distVersion = answers.version;
}

export async function commitPrepareReleaseVersion(config: BuildConfig) {
  const commitPaths: string[] = [];

  // update root
  const rootPkg = await readPackageJson(config.rootDir);
  commitPaths.push(join(config.rootDir, 'package.json'));
  const updatedPkg = { ...rootPkg };
  updatedPkg.version = config.distVersion;
  await writePackageJson(config.rootDir, updatedPkg);

  // update packages/qwik
  const qwikDir = join(config.packagesDir, 'qwik');
  const qwikPkg = await readPackageJson(qwikDir);
  commitPaths.push(join(qwikDir, 'package.json'));
  qwikPkg.version = config.distVersion;
  await writePackageJson(qwikDir, qwikPkg);

  // update the cli version
  const distCliDir = join(config.packagesDir, 'create-qwik');
  commitPaths.push(join(distCliDir, 'package.json'));
  const cliPkg = await readPackageJson(distCliDir);
  cliPkg.version = config.distVersion;
  await writePackageJson(distCliDir, cliPkg);

  // update the eslint version
  const distEslintDir = join(config.packagesDir, 'eslint-plugin-qwik');
  commitPaths.push(join(distEslintDir, 'package.json'));
  const eslintPkg = await readPackageJson(distEslintDir);
  eslintPkg.version = config.distVersion;
  await writePackageJson(distEslintDir, eslintPkg);

  // git add the changed package.json
  const gitAddArgs = ['add', ...commitPaths];
  await run('git', gitAddArgs);

  // git commit the changed package.json
  const gitCommitArgs = ['commit', '--message', config.distVersion];
  await run('git', gitCommitArgs);

  console.log(``);
  console.log(`Next:`);
  console.log(` - Submit a PR to main with the package.json update`);
  console.log(` - Once merged, run the "Qwik CI" release workflow`);
  console.log(` - https://github.com/BuilderIO/qwik/actions/workflows/ci.yml`);
  console.log(``);
}

export async function publish(config: BuildConfig) {
  const isDryRun = !!config.dryRun;

  const distPkgDir = config.distPkgDir;
  const distPkg = await readPackageJson(distPkgDir);
  const version = distPkg.version;
  const gitTag = `v${version}`;
  const distTag = config.setDistTag || 'dev';

  console.log(`🚢 publishing ${distPkg.name} ${version}`, isDryRun ? '(dry-run)' : '');

  // create a pack.tgz which is useful for debugging and uploaded as an artifact
  const pkgTarName = `builder.io-qwik-${version}.tgz`;
  await execa('npm', ['pack'], { cwd: distPkgDir });
  await execa('mv', [pkgTarName, '../'], { cwd: distPkgDir });

  // make sure our build is good to go and has the files we expect
  // and each of the files can be parsed correctly
  await validateBuild(config);

  // check all is good with an npm publish --dry-run before we continue
  // dry-run does everything the same except actually publish to npm
  const npmPublishArgs = ['publish', '--tag', distTag, '--access', 'public'];
  await run('npm', npmPublishArgs, true, true, { cwd: distPkgDir });

  // looks like the npm publish --dry-run was successful and
  // we have more confidence that it should work on a real publish

  // set the user git config email
  const actor = process.env.GITHUB_ACTOR || 'builderbot';
  const actorEmail = `${actor}@users.noreply.github.com`;
  const gitConfigEmailArgs = ['config', 'user.email', actorEmail];
  await run('git', gitConfigEmailArgs, isDryRun);

  // set the user git config name
  const gitConfigNameArgs = ['config', 'user.name', actor];
  await run('git', gitConfigNameArgs, isDryRun);

  // git tag this commit
  const gitTagArgs = ['tag', '-f', '-m', version, gitTag];
  await run('git', gitTagArgs, isDryRun);

  if (isDryRun) {
    // git push only logs and does not execute in this dry run
    const gitPushArgs = ['push', '--follow-tags'];
    await run('git', gitPushArgs, true, false);
  } else {
    // production release
    // git push to the repo w/ --dry-run flag to make sure we're good before publishing
    const gitPushArgs = ['push', '--follow-tags'];
    if (!config.devRelease) {
      await run('git', gitPushArgs, false, true);
    }

    // if we've made it this far then the npm publish dry-run passed
    // and all of the git commands worked, time to publish!!
    // ⛴ LET'S GO!!
    await run('npm', npmPublishArgs, false, false, { cwd: distPkgDir });

    console.log(`   https://www.npmjs.com/package/${distPkg.name}`);

    if (!config.devRelease) {
      // git push to the production repo w/out the dry-run flag
      // now that it's officially published to npm
      await run('git', gitPushArgs, false, false);
    }
  }

  if (!config.devRelease) {
    // create a github release using the git tag we just pushed
    await createGithubRelease(version, gitTag, isDryRun);
  }

  console.log(
    `🐋 published version "${version}" of ${distPkg.name} with dist-tag "${distTag}" to npm`,
    isDryRun ? '(dry-run)' : ''
  );

  await publishCreateQwikCli(config, distTag, version, isDryRun);
  await publishEslint(config, distTag, version, isDryRun);
}

async function createGithubRelease(version: string, gitTag: string, isDryRun: boolean) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split('/');
  const isPrerelease = !!semver.prerelease(version);

  const ghUrl = 'POST /repos/{owner}/{repo}/releases';
  const ghData = {
    owner,
    repo,
    tag_name: gitTag,
    prerelease: isPrerelease,
    generate_release_notes: true,
  };
  console.log(`   ${ghUrl} ${JSON.stringify(ghData)}`, isDryRun ? '(dry-run)' : '');

  if (!isDryRun) {
    // https://docs.github.com/en/rest/reference/repos#create-a-release
    const octokit = new Octokit();
    await octokit.request(ghUrl, ghData);
    console.log(
      `🐋 created github release "${gitTag}": https://github.com/${owner}/${repo}/releases`
    );
  }
}

export async function checkExistingNpmVersion(pkgName: string, newVersion: string) {
  if (newVersion !== '0.0.1') {
    const npmVersionsCall = await execa('npm', ['view', pkgName, 'versions', '--json']);
    const publishedVersions: string[] = JSON.parse(npmVersionsCall.stdout);
    if (publishedVersions.includes(newVersion)) {
      panic(`Version "${newVersion}" of ${pkgName} is already published to npm`);
    } else {
      console.log(`✅ Version "${newVersion}" of ${pkgName} is not already published to npm`);
    }
  }
}

export async function releaseVersionPrompt(pkgName: string, currentVersion: string) {
  const answers = await prompts({
    type: 'select',
    name: 'version',
    message: `Select ${pkgName} version`,
    validate: async (version: string) => {
      const validVersion = semver.valid(version)!;
      if (!validVersion) {
        panic(`Invalid semver version "${version}" for ${pkgName}`);
      }
      await checkExistingNpmVersion(pkgName, version);
      return true;
    },
    choices: SEMVER_RELEASE_TYPES.map((v) => {
      return {
        title: `${v}  ${semver.inc(currentVersion, v)}`,
        value: semver.inc(currentVersion, v)!,
      };
    }),
  });
  return answers;
}

const SEMVER_RELEASE_TYPES: semver.ReleaseType[] = [
  'prerelease',
  'prepatch',
  'patch',
  'preminor',
  'minor',
  'premajor',
  'major',
];
