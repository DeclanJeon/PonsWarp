#!/usr/bin/env node

/**
 * Version Bump Script
 * 
 * 이 스크립트는 시맨틱 버전 관리를 위해 버전을 자동으로 증가시킵니다.
 * 커밋 메시지를 분석하여 적절한 버전 타입을 결정합니다.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 버전 타입 정의
const VERSION_TYPES = {
  MAJOR: 'major',
  MINOR: 'minor', 
  PATCH: 'patch'
};

// 커밋 타입과 버전 타입 매핑
const COMMIT_TYPE_MAP = {
  'feat': VERSION_TYPES.MINOR,
  'fix': VERSION_TYPES.PATCH,
  'perf': VERSION_TYPES.PATCH,
  'refactor': VERSION_TYPES.PATCH,
  'docs': VERSION_TYPES.PATCH,
  'style': VERSION_TYPES.PATCH,
  'test': VERSION_TYPES.PATCH,
  'chore': VERSION_TYPES.PATCH,
  'build': VERSION_TYPES.PATCH,
  'ci': VERSION_TYPES.PATCH
};

// BREAKING CHANGE가 포함된 커밋은 항상 MAJOR
const BREAKING_CHANGE_PATTERNS = [
  /BREAKING CHANGE/i,
  /breaking change/i,
  /!:/
];

class VersionBumper {
  constructor() {
    this.packageJsonPath = path.join(process.cwd(), 'package.json');
    this.currentVersion = this.getCurrentVersion();
  }

  /**
   * 현재 버전 읽기
   */
  getCurrentVersion() {
    const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
    return packageJson.version;
  }

  /**
   * 버전 파싱
   */
  parseVersion(version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) {
      throw new Error(`Invalid version format: ${version}`);
    }

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4] || null
    };
  }

  /**
   * 버전 문자열 생성
   */
  formatVersion(versionObj, prerelease = null) {
    const base = `${versionObj.major}.${versionObj.minor}.${versionObj.patch}`;
    return prerelease ? `${base}-${prerelease}` : base;
  }

  /**
   * 버전 증가
   */
  bumpVersion(type, prerelease = null) {
    const version = this.parseVersion(this.currentVersion);

    switch (type) {
      case VERSION_TYPES.MAJOR:
        version.major++;
        version.minor = 0;
        version.patch = 0;
        break;
      case VERSION_TYPES.MINOR:
        version.minor++;
        version.patch = 0;
        break;
      case VERSION_TYPES.PATCH:
        version.patch++;
        break;
      default:
        throw new Error(`Unknown version type: ${type}`);
    }

    return this.formatVersion(version, prerelease);
  }

  /**
   * 마지막 태그 이후의 커밋 가져오기
   */
  getCommitsSinceLastTag() {
    try {
      // 마지막 태그 가져오기
      const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
      
      // 마지막 태그 이후의 커밋 로그 가져오기
      const commits = execSync(
        `git log ${lastTag}..HEAD --pretty=format:"%H|%s|%b"`,
        { encoding: 'utf8' }
      ).trim().split('\n');

      return commits.filter(commit => commit.trim());
    } catch (error) {
      // 태그가 없는 경우 모든 커밋 반환
      const commits = execSync(
        'git log --pretty=format:"%H|%s|%b"',
        { encoding: 'utf8' }
      ).trim().split('\n');

      return commits.filter(commit => commit.trim());
    }
  }

  /**
   * 커밋 메시지 분석
   */
  analyzeCommits() {
    const commits = this.getCommitsSinceLastTag();
    
    let versionType = null;
    let hasBreakingChange = false;
    const features = [];
    const fixes = [];
    const others = [];

    for (const commit of commits) {
      const [hash, subject, body] = commit.split('|');
      const fullMessage = `${subject}\n${body}`;

      // BREAKING CHANGE 확인
      const hasBreaking = BREAKING_CHANGE_PATTERNS.some(pattern => 
        pattern.test(fullMessage)
      );

      if (hasBreaking) {
        hasBreakingChange = true;
      }

      // 커밋 타입 추출
      const match = subject.match(/^(\w+)(?:\(.+\))?:/);
      const commitType = match ? match[1] : null;

      if (commitType && COMMIT_TYPE_MAP[commitType]) {
        const mappedType = COMMIT_TYPE_MAP[commitType];
        
        // 더 높은 우선순위의 버전 타입 선택
        if (!versionType || this.getPriority(mappedType) > this.getPriority(versionType)) {
          versionType = mappedType;
        }

        // 기능/버그 분류
        if (commitType === 'feat') {
          features.push(subject);
        } else if (commitType === 'fix') {
          fixes.push(subject);
        } else {
          others.push(subject);
        }
      }
    }

    // BREAKING CHANGE가 있으면 항상 MAJOR
    if (hasBreakingChange) {
      versionType = VERSION_TYPES.MAJOR;
    }

    return {
      versionType,
      hasBreakingChange,
      features,
      fixes,
      others,
      totalCommits: commits.length
    };
  }

  /**
   * 버전 타입 우선순위
   */
  getPriority(type) {
    const priorities = {
      [VERSION_TYPES.MAJOR]: 3,
      [VERSION_TYPES.MINOR]: 2,
      [VERSION_TYPES.PATCH]: 1
    };
    return priorities[type] || 0;
  }

  /**
   * 프리릴리즈 버전 결정
   */
  determinePrerelease(branch) {
    if (branch === 'develop') {
      return 'beta';
    } else if (branch.startsWith('feature/')) {
      return 'alpha';
    } else if (branch.startsWith('release/')) {
      return 'rc';
    }
    return null;
  }

  /**
   * package.json 업데이트
   */
  updatePackageJson(newVersion) {
    const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
    packageJson.version = newVersion;
    
    fs.writeFileSync(
      this.packageJsonPath,
      JSON.stringify(packageJson, null, 2) + '\n'
    );

    console.log(`✅ Updated package.json to version ${newVersion}`);
  }

  /**
   * Git 태그 생성
   */
  createTag(version, message) {
    execSync(`git add package.json`);
    execSync(`git commit -m "chore(release): ${version} [skip ci]\n\n${message}"`);
    execSync(`git tag -a v${version} -m "${message}"`);
    
    console.log(`✅ Created tag v${version}`);
  }

  /**
   * 메인 실행 함수
   */
  async run(options = {}) {
    const {
      type = null,
      prerelease = null,
      branch = process.env.GITHUB_REF_NAME || 'main',
      dryRun = false
    } = options;

    console.log(`📦 Current version: ${this.currentVersion}`);
    console.log(`🌿 Branch: ${branch}`);

    let newVersion;
    let analysis;

    if (type) {
      // 수동 버전 타입 지정
      newVersion = this.bumpVersion(type, prerelease);
      console.log(`🔧 Manual version bump: ${type} -> ${newVersion}`);
    } else {
      // 커밋 분석으로 버전 결정
      analysis = this.analyzeCommits();
      
      if (!analysis.versionType) {
        console.log('ℹ️ No version bump needed');
        return null;
      }

      const autoPrerelease = prerelease || this.determinePrerelease(branch);
      newVersion = this.bumpVersion(analysis.versionType, autoPrerelease);
      
      console.log(`🤖 Auto version bump: ${analysis.versionType} -> ${newVersion}`);
      console.log(`📊 Analysis: ${analysis.totalCommits} commits, ${analysis.features.length} features, ${analysis.fixes.length} fixes`);
    }

    if (dryRun) {
      console.log(`🔍 Dry run: would bump to ${newVersion}`);
      return newVersion;
    }

    // package.json 업데이트
    this.updatePackageJson(newVersion);

    // Git 태그 생성
    const tagMessage = this.generateTagMessage(newVersion, analysis);
    this.createTag(newVersion, tagMessage);

    return newVersion;
  }

  /**
   * 태그 메시지 생성
   */
  generateTagMessage(version, analysis) {
    if (!analysis) {
      return `Release ${version}`;
    }

    let message = `Release ${version}\n\n`;

    if (analysis.features.length > 0) {
      message += '### Features\n\n';
      analysis.features.forEach(feature => {
        message += `- ${feature}\n`;
      });
      message += '\n';
    }

    if (analysis.fixes.length > 0) {
      message += '### Bug Fixes\n\n';
      analysis.fixes.forEach(fix => {
        message += `- ${fix}\n`;
      });
      message += '\n';
    }

    if (analysis.hasBreakingChange) {
      message += '### BREAKING CHANGES\n\n';
      message += '- This release contains breaking changes\n\n';
    }

    return message.trim();
  }
}

// CLI 실행
if (require.main === module) {
  const bumper = new VersionBumper();
  
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--type' && args[i + 1]) {
      options.type = args[i + 1];
      i++;
    } else if (arg === '--prerelease' && args[i + 1]) {
      options.prerelease = args[i + 1];
      i++;
    } else if (arg === '--branch' && args[i + 1]) {
      options.branch = args[i + 1];
      i++;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help') {
      console.log(`
Usage: node version-bump.js [options]

Options:
  --type <type>        Version type: major, minor, patch
  --prerelease <type>  Prerelease type: alpha, beta, rc
  --branch <name>      Git branch name
  --dry-run           Show what would be done without making changes
  --help              Show this help message

Examples:
  node version-bump.js --type minor --prerelease beta
  node version-bump.js --dry-run
      `);
      process.exit(0);
    }
  }
  
  bumper.run(options)
    .then(version => {
      if (version) {
        console.log(`🎉 Version bumped to ${version}`);
      }
    })
    .catch(error => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

module.exports = VersionBumper;