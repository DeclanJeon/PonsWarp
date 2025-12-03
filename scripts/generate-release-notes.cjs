#!/usr/bin/env node

/**
 * Release Notes Generator
 * 
 * 이 스크립트는 Git 커밋 히스토리를 기반으로 자동으로 릴리스 노트를 생성합니다.
 * 시맨틱 버전 관리와 컨벤셔널 커밋 메시지를 지원합니다.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class ReleaseNotesGenerator {
  constructor() {
    this.repoUrl = this.getRepoUrl();
    this.issues = new Map();
    this.authors = new Map();
  }

  /**
   * 저장소 URL 가져오기
   */
  getRepoUrl() {
    try {
      const remoteUrl = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
      
      // HTTPS URL 변환
      if (remoteUrl.startsWith('git@')) {
        return remoteUrl
          .replace('git@github.com:', 'https://github.com/')
          .replace('.git', '');
      }
      
      return remoteUrl.replace('.git', '');
    } catch (error) {
      console.warn('Could not determine repository URL');
      return '';
    }
  }

  /**
   * 마지막 태그 이후의 커밋 가져오기
   */
  getCommitsSinceLastTag() {
    try {
      // 마지막 태그 가져오기
      const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
      console.log(`📝 Generating notes since tag: ${lastTag}`);
      
      // 마지막 태그 이후의 커밋 로그 가져오기
      const commits = execSync(
        `git log ${lastTag}..HEAD --pretty=format:"%H|%s|%b|%an|%ae"`,
        { encoding: 'utf8' }
      ).trim().split('\n');

      return commits.filter(commit => commit.trim());
    } catch (error) {
      // 태그가 없는 경우 모든 커밋 반환
      console.log('📝 No previous tags found, generating notes for all commits');
      const commits = execSync(
        'git log --pretty=format:"%H|%s|%b|%an|%ae"',
        { encoding: 'utf8' }
      ).trim().split('\n');

      return commits.filter(commit => commit.trim());
    }
  }

  /**
   * 커밋 파싱
   */
  parseCommit(commitLine) {
    const [hash, subject, body, author, email] = commitLine.split('|');
    
    // 이슈 번호 추출
    const issueNumbers = this.extractIssueNumbers(subject + ' ' + body);
    
    // 커밋 타입과 스코프 추출
    const typeMatch = subject.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
    const type = typeMatch ? typeMatch[1] : 'chore';
    const scope = typeMatch ? typeMatch[2] : null;
    const description = typeMatch ? typeMatch[3] : subject;

    // BREAKING CHANGE 확인
    const hasBreakingChange = this.hasBreakingChange(subject, body);

    // 저자 정보 저장
    if (author && email) {
      this.authors.set(email, { name: author, email });
    }

    // 이슈 정보 저장
    issueNumbers.forEach(issueNum => {
      if (!this.issues.has(issueNum)) {
        this.issues.set(issueNum, { number: issueNum, title: null, url: null });
      }
    });

    return {
      hash,
      type,
      scope,
      description,
      subject,
      body,
      author,
      email,
      issueNumbers,
      hasBreakingChange
    };
  }

  /**
   * 이슈 번호 추출
   */
  extractIssueNumbers(text) {
    const patterns = [
      /#(\d+)/g,
      /(?:fixes|closes|resolves)\s+#?(\d+)/gi,
      /(?:issue|gh)-(\d+)/gi
    ];

    const issues = new Set();
    
    patterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          const issueNum = match.match(/\d+/)[0];
          issues.add(issueNum);
        });
      }
    });

    return Array.from(issues);
  }

  /**
   * BREAKING CHANGE 확인
   */
  hasBreakingChange(subject, body) {
    const patterns = [
      /BREAKING CHANGE/i,
      /breaking change/i,
      /!:/
    ];

    return patterns.some(pattern => 
      pattern.test(subject) || pattern.test(body)
    );
  }

  /**
   * 커밋 분류
   */
  categorizeCommits(commits) {
    const categories = {
      breaking: [],
      features: [],
      fixes: [],
      performance: [],
      refactor: [],
      docs: [],
      style: [],
      test: [],
      build: [],
      ci: [],
      chore: [],
      other: []
    };

    commits.forEach(commit => {
      if (commit.hasBreakingChange) {
        categories.breaking.push(commit);
      }

      switch (commit.type) {
        case 'feat':
          categories.features.push(commit);
          break;
        case 'fix':
          categories.fixes.push(commit);
          break;
        case 'perf':
          categories.performance.push(commit);
          break;
        case 'refactor':
          categories.refactor.push(commit);
          break;
        case 'docs':
          categories.docs.push(commit);
          break;
        case 'style':
          categories.style.push(commit);
          break;
        case 'test':
          categories.test.push(commit);
          break;
        case 'build':
          categories.build.push(commit);
          break;
        case 'ci':
          categories.ci.push(commit);
          break;
        case 'chore':
          categories.chore.push(commit);
          break;
        default:
          categories.other.push(commit);
      }
    });

    return categories;
  }

  /**
   * 커밋 설명 포맷팅
   */
  formatCommitDescription(commit) {
    let description = commit.description;

    // 이슈 번호를 링크로 변환
    if (this.repoUrl && commit.issueNumbers.length > 0) {
      commit.issueNumbers.forEach(issueNum => {
        const issueLink = `[#${issueNum}](${this.repoUrl}/issues/${issueNum})`;
        description = description.replace(new RegExp(`#${issueNum}`, 'g'), issueLink);
        description = description.replace(new RegExp(`issue-${issueNum}`, 'gi'), issueLink);
      });
    }

    // 스코프 추가
    if (commit.scope) {
      description = `**${commit.scope}**: ${description}`;
    }

    return description;
  }

  /**
   * 섹션 생성
   */
  generateSection(title, commits, showEmpty = false) {
    if (commits.length === 0 && !showEmpty) {
      return '';
    }

    let section = `### ${title}\n\n`;

    if (commits.length === 0) {
      section += '*No changes*\n\n';
      return section;
    }

    commits.forEach(commit => {
      const description = this.formatCommitDescription(commit);
      const shortHash = commit.hash.substring(0, 7);
      const commitLink = this.repoUrl ? 
        `([${shortHash}](${this.repoUrl}/commit/${commit.hash}))` : 
        `(${shortHash})`;

      section += `- ${description} ${commitLink}\n`;
    });

    section += '\n';
    return section;
  }

  /**
   * 통계 섹션 생성
   */
  generateStats(categories) {
    const totalCommits = Object.values(categories).flat().length;
    const contributors = Array.from(this.authors.values()).length;
    const closedIssues = this.issues.size;

    return `
### 📊 Statistics

- **Total Commits**: ${totalCommits}
- **Contributors**: ${contributors}
- **Closed Issues**: ${closedIssues}
- **Features**: ${categories.features.length}
- **Bug Fixes**: ${categories.fixes.length}

`;
  }

  /**
   * 기여자 섹션 생성
   */
  generateContributors() {
    if (this.authors.size === 0) {
      return '';
    }

    let section = '### 👥 Contributors\n\n';
    
    Array.from(this.authors.values()).forEach(contributor => {
      section += `- ${contributor.name} (${contributor.email})\n`;
    });

    section += '\n';
    return section;
  }

  /**
   * 메인 릴리스 노트 생성
   */
  generateReleaseNotes(version, date) {
    const commits = this.getCommitsSinceLastTag();
    const parsedCommits = commits.map(commit => this.parseCommit(commit));
    const categories = this.categorizeCommits(parsedCommits);

    let releaseNotes = `# Release ${version}\n\n`;
    releaseNotes += `**Published on**: ${date}\n\n`;

    // BREAKING CHANGES 섹션 (가장 중요)
    if (categories.breaking.length > 0) {
      releaseNotes += this.generateSection('⚠️ BREAKING CHANGES', categories.breaking);
      releaseNotes += '---\n\n';
    }

    // 기능 섹션
    releaseNotes += this.generateSection('✨ Features', categories.features);

    // 버그 수정 섹션
    releaseNotes += this.generateSection('🐛 Bug Fixes', categories.fixes);

    // 성능 개선 섹션
    releaseNotes += this.generateSection('⚡ Performance', categories.performance);

    // 리팩토링 섹션
    releaseNotes += this.generateSection('♻️ Refactoring', categories.refactor);

    // 문서 섹션
    releaseNotes += this.generateSection('📝 Documentation', categories.docs);

    // 테스트 섹션
    releaseNotes += this.generateSection('🧪 Tests', categories.test);

    // 빌드/CI 섹션
    releaseNotes += this.generateSection('🔧 Build & CI', [...categories.build, ...categories.ci]);

    // 스타일 섹션
    releaseNotes += this.generateSection('🎨 Styling', categories.style);

    // 기타 섹션
    releaseNotes += this.generateSection('🔀 Other Changes', categories.chore);

    // 통계 섹션
    releaseNotes += this.generateStats(categories);

    // 기여자 섹션
    releaseNotes += this.generateContributors();

    // 푸터
    releaseNotes += `---\n\n`;
    releaseNotes += `🤖 This release was automatically generated.\n`;

    return releaseNotes;
  }

  /**
   * 릴리스 노트 저장
   */
  saveReleaseNotes(version, content) {
    const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
    
    let changelog = '';
    if (fs.existsSync(changelogPath)) {
      changelog = fs.readFileSync(changelogPath, 'utf8');
    }

    // 새 릴리스 노트를 맨 위에 추가
    const newContent = content + '\n' + changelog;
    
    fs.writeFileSync(changelogPath, newContent);
    console.log(`✅ Updated CHANGELOG.md with version ${version}`);
  }

  /**
   * 메인 실행 함수
   */
  async run(options = {}) {
    const {
      version = null,
      date = new Date().toISOString().split('T')[0],
      output = null,
      updateChangelog = true
    } = options;

    if (!version) {
      throw new Error('Version is required');
    }

    console.log(`📝 Generating release notes for version ${version}`);

    const releaseNotes = this.generateReleaseNotes(version, date);

    if (output) {
      fs.writeFileSync(output, releaseNotes);
      console.log(`✅ Release notes saved to ${output}`);
    }

    if (updateChangelog) {
      this.saveReleaseNotes(version, releaseNotes);
    }

    return releaseNotes;
  }
}

// CLI 실행
if (require.main === module) {
  const generator = new ReleaseNotesGenerator();
  
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--version' && args[i + 1]) {
      options.version = args[i + 1];
      i++;
    } else if (arg === '--date' && args[i + 1]) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--output' && args[i + 1]) {
      options.output = args[i + 1];
      i++;
    } else if (arg === '--no-changelog') {
      options.updateChangelog = false;
    } else if (arg === '--help') {
      console.log(`
Usage: node generate-release-notes.js [options]

Options:
  --version <version>    Release version (required)
  --date <date>         Release date (default: today)
  --output <file>       Output file (default: stdout)
  --no-changelog        Don't update CHANGELOG.md
  --help               Show this help message

Examples:
  node generate-release-notes.js --version 1.2.0
  node generate-release-notes.js --version 1.2.0 --output release-notes.md
      `);
      process.exit(0);
    }
  }
  
  if (!options.version) {
    console.error('❌ Version is required. Use --version <version>');
    process.exit(1);
  }
  
  generator.run(options)
    .then(notes => {
      if (!options.output) {
        console.log(notes);
      }
    })
    .catch(error => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

module.exports = ReleaseNotesGenerator;