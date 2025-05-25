const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;
const path = require('path');

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.owner = process.env.GITHUB_OWNER;
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [],
      weeklyCommits: 0
    };
  }

  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    
    // Define organizations/users to scan
    const targets = [
      { type: 'user', name: this.owner },
      // Add more organizations here:
      // { type: 'org', name: 'your-research-org' },
      // { type: 'user', name: 'collaborator-username' }
    ];
    
    try {
      for (const target of targets) {
        console.log(`🔍 Scanning ${target.type}: ${target.name}`);
        
        const { data: repos } = target.type === 'org' 
          ? await this.octokit.rest.repos.listForOrg({
              org: target.name,
              type: 'all',
              per_page: 100
            })
          : await this.octokit.rest.repos.listForUser({
              username: target.name,
              type: 'all',
              per_page: 100
            });

        // Filter repositories that are part of 100SV initiative
        for (const repo of repos) {
          if (await this.is100SVRepository(repo)) {
            const paperList = await this.analyzePaper(repo);
            if (paperList && paperList.length > 0) {
              this.papers.push(...paperList); // Spread array since analyzePaper now returns array
            }
          }
        }
      }

      console.log(`📊 Found ${this.papers.length} paper repositories across all targets`);
    } catch (error) {
      console.error('Error discovering papers:', error.message);
    }
  }

  async is100SVRepository(repo) {
    // Method 1: Check for 100SV.md identifier file
    try {
      await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: '100SV.md'
      });
      console.log(`✅ Found 100SV.md in ${repo.name}`);
      return true;
    } catch (error) {
      // 100SV.md doesn't exist, try other methods
    }

    // Method 2: Check for specific topic tags
    if (repo.topics && repo.topics.includes('100-scientific-visions')) {
      console.log(`✅ Found topic tag in ${repo.name}`);
      return true;
    }

    // Method 3: Check for papers folder AND SC- prefix (legacy support)
    if (repo.name.startsWith('SC-') || repo.name.includes('scientific-vision')) {
      if (await this.hasPapersFolder(repo)) {
        console.log(`✅ Found SC- prefix + papers folder in ${repo.name}`);
        return true;
      }
    }

    // Method 4: Check description for keywords
    if (repo.description && 
        (repo.description.toLowerCase().includes('100 scientific visions') ||
         repo.description.toLowerCase().includes('100sv'))) {
      if (await this.hasPapersFolder(repo)) {
        console.log(`✅ Found keywords in description of ${repo.name}`);
        return true;
      }
    }

    return false;
  }

  async analyzePaper(repo) {
    try {
      console.log(`📝 Analyzing ${repo.name}...`);
      
      const papers = [];

      // Check if this is a multi-paper repository
      const subpapers = await this.findSubpapers(repo);
      
      if (subpapers.length > 0) {
        // Multiple papers in subdirectories
        for (const subpaper of subpapers) {
          const paper = await this.analyzeSubpaper(repo, subpaper);
          if (paper) papers.push(paper);
        }
      } else {
        // Single paper repository
        const paper = await this.analyzeSinglePaper(repo);
        if (paper) papers.push(paper);
      }

      return papers;
    } catch (error) {
      console.error(`Error analyzing ${repo.name}:`, error.message);
      return [];
    }
  }

  async findSubpapers(repo) {
    try {
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: 'papers'
      });

      const subdirs = contents.filter(item => 
        item.type === 'dir' && 
        (item.name.match(/^P\d+$/) || item.name.match(/^[A-Z]{2,3}$/) || item.name.length <= 10)
      );

      console.log(`📁 Found ${subdirs.length} potential subpapers in ${repo.name}`);
      return subdirs.map(dir => dir.name);
    } catch (error) {
      return [];
    }
  }

  async analyzeSubpaper(repo, subpaperDir) {
    const paper = {
      repoName: repo.name,
      paperName: subpaperDir,
      fullName: `${repo.name}/${subpaperDir}`,
      description: repo.description || 'No description',
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`,
      repoUrl: repo.html_url,
      private: repo.private,
      topics: repo.topics || [],
      lastUpdated: repo.updated_at,
      status: 'Unknown',
      priority: 'Medium',
      progress: {},
      commits: 0,
      preprintLink: null,
      publishedLink: null,
      isSubpaper: true
    };

    // Try to read progress.md from subpaper directory
    try {
      const { data: progressFile } = await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: `papers/${subpaperDir}/progress.md`
      });

      if (progressFile.content) {
        const content = Buffer.from(progressFile.content, 'base64').toString();
        paper.progress = this.parseProgress(content);
        paper.status = paper.progress.status || 'Unknown';
        paper.priority = paper.progress.priority || 'Medium';
        paper.preprintLink = paper.progress.preprintLink;
        paper.publishedLink = paper.progress.publishedLink;
      }
    } catch (error) {
      // No progress.md in subpaper, try 100SV.md
      try {
        const { data: svFile } = await this.octokit.rest.repos.getContent({
          owner: repo.owner.login,
          repo: repo.name,
          path: `papers/${subpaperDir}/100SV.md`
        });

        if (svFile.content) {
          const content = Buffer.from(svFile.content, 'base64').toString();
          const svData = this.parse100SV(content);
          paper.description = svData.researchFocus || paper.description;
          paper.projectId = svData.projectId;
          paper.researchArea = svData.researchArea;
        }
      } catch (error) {
        // Neither file exists, infer status
        paper.status = this.inferStatusFromActivity(repo);
      }
    }

    return paper;
  }

  async analyzeSinglePaper(repo) {
    const paper = {
      repoName: repo.name,
      paperName: repo.name,
      fullName: repo.name,
      description: repo.description || 'No description',
      url: repo.html_url,
      repoUrl: repo.html_url,
      private: repo.private,
      topics: repo.topics || [],
      lastUpdated: repo.updated_at,
      status: 'Unknown',
      priority: 'Medium',
      progress: {},
      commits: 0,
      preprintLink: null,
      publishedLink: null,
      isSubpaper: false
    };

    // Try to read progress.md from papers folder
    try {
      const { data: progressFile } = await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: 'papers/progress.md'
      });

      if (progressFile.content) {
        const content = Buffer.from(progressFile.content, 'base64').toString();
        paper.progress = this.parseProgress(content);
        paper.status = paper.progress.status || 'Unknown';
        paper.priority = paper.progress.priority || 'Medium';
        paper.preprintLink = paper.progress.preprintLink;
        paper.publishedLink = paper.progress.publishedLink;
      }
    } catch (error) {
      paper.status = this.inferStatusFromActivity(repo);
    }

    // Get historical statistics
    const historicalStats = await this.getHistoricalStats(repo);
    if (historicalStats) {
      paper.historical = historicalStats;
      paper.projectAge = historicalStats.age;
      paper.total3MonthCommits = historicalStats.totalCommits3Months;
    }

    // Get recent commit activity
    if (!repo.private) {
      try {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const { data: commits } = await this.octokit.rest.repos.listCommits({
          owner: repo.owner.login,
          repo: repo.name,
          since: weekAgo.toISOString(),
          per_page: 100
        });

        paper.commits = commits.length;
        this.stats.weeklyCommits += commits.length;

        if (commits.length > 0) {
          this.stats.recentActivity.push({
            repo: paper.fullName,
            commits: commits.length,
            lastCommit: commits[0].commit.message
          });
        }
      } catch (error) {
        console.log(`⚠️  Cannot access commit data for ${repo.name}`);
      }
    }

    return paper;
  }

  parseProgress(content) {
    const progress = {
      status: 'Unknown',
      priority: 'Medium',
      phase: [],
      nextSteps: '',
      timeline: {},
      preprintLink: null,
      publishedLink: null
    };

    // Extract status
    const statusMatch = content.match(/\*\*Status\*\*:\s*\[?([^\]\n]+)\]?/);
    if (statusMatch) {
      progress.status = statusMatch[1].trim();
    }

    // Extract priority
    const priorityMatch = content.match(/\*\*Priority\*\*:\s*\[?([^\]\n]+)\]?/);
    if (priorityMatch) {
      progress.priority = priorityMatch[1].trim();
    }

    // Extract preprint link
    const preprintMatch = content.match(/\*\*Preprint\*\*:\s*\[?([^\]\n]+)\]?/) || 
                         content.match(/\*\*arXiv\*\*:\s*\[?([^\]\n]+)\]?/) ||
                         content.match(/Preprint:\s*([^\n]+)/);
    if (preprintMatch) {
      progress.preprintLink = preprintMatch[1].trim();
    }

    // Extract published article link
    const publishedMatch = content.match(/\*\*Published\*\*:\s*\[?([^\]\n]+)\]?/) ||
                          content.match(/\*\*DOI\*\*:\s*\[?([^\]\n]+)\]?/) ||
                          content.match(/Published:\s*([^\n]+)/);
    if (publishedMatch) {
      progress.publishedLink = publishedMatch[1].trim();
    }

    // Extract completed phases
    const phaseMatches = content.match(/- \[x\]\s*([^\n]+)/g);
    if (phaseMatches) {
      progress.phase = phaseMatches.map(match => match.replace(/- \[x\]\s*/, ''));
    }

    return progress;
  }

  parse100SV(content) {
    const svData = {
      projectId: null,
      researchArea: null,
      researchFocus: null
    };

    // Extract project ID
    const idMatch = content.match(/\*\*Project ID\*\*:\s*\[?([^\]\n]+)\]?/);
    if (idMatch) {
      svData.projectId = idMatch[1].trim();
    }

    // Extract research area
    const areaMatch = content.match(/\*\*Research Area\*\*:\s*\[?([^\]\n]+)\]?/);
    if (areaMatch) {
      svData.researchArea = areaMatch[1].trim();
    }

    // Extract research focus
    const focusMatch = content.match(/## Research Focus\n([^#]+)/);
    if (focusMatch) {
      svData.researchFocus = focusMatch[1].trim();
    }

    return svData;
  }

  inferStatusFromActivity(repo) {
    const daysSinceUpdate = Math.floor((new Date() - new Date(repo.updated_at)) / (1000 * 60 * 60 * 24));
    
    if (daysSinceUpdate < 7) return 'Active';
    if (daysSinceUpdate < 30) return 'Recent';
    if (daysSinceUpdate < 90) return 'Inactive';
    return 'Stale';
  }

  generateStats() {
    this.stats.total = this.papers.length;
    
    // Group by status
    this.stats.byStatus = {};
    this.papers.forEach(paper => {
      this.stats.byStatus[paper.status] = (this.stats.byStatus[paper.status] || 0) + 1;
    });

    // Group by priority
    this.stats.byPriority = {};
    this.papers.forEach(paper => {
      this.stats.byPriority[paper.priority] = (this.stats.byPriority[paper.priority] || 0) + 1;
    });

    // Sort recent activity by commit count
    this.stats.recentActivity.sort((a, b) => b.commits - a.commits);
    this.stats.recentActivity = this.stats.recentActivity.slice(0, 10); // Top 10
  }

  async updateReadme() {
    console.log('📝 Updating main README...');
    
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    
    let readme = `# 100 Scientific Visions by Daniel Sandner

## Project Overview
A comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.

## Current Status Dashboard
*Last updated: ${timestamp}*

### Quick Stats
- 📊 **Total Papers**: ${this.stats.total} discovered
- 🟢 **Active Projects**: ${this.stats.byStatus['Active'] || 0}
- 🟡 **In Planning**: ${this.stats.byStatus['Planning'] || 0}
- 🔴 **Need Attention**: ${this.stats.byStatus['Stale'] || 0}
- 📈 **This Week's Commits**: ${this.stats.weeklyCommits}

### Recent Activity
`;

    if (this.stats.recentActivity.length > 0) {
      this.stats.recentActivity.forEach(activity => {
        readme += `- **${activity.repo}**: ${activity.commits} commits - "${activity.lastCommit}"\n`;
      });
    } else {
      readme += '*No recent activity detected*\n';
    }

    readme += `
## Research Areas
*Auto-generated based on repository topics*

### By Status
`;

    Object.entries(this.stats.byStatus).forEach(([status, count]) => {
      readme += `- **${status}**: ${count} papers\n`;
    });

    readme += `
### Priority Distribution
`;

    Object.entries(this.stats.byPriority).forEach(([priority, count]) => {
      const emoji = priority === 'High' ? '🔴' : priority === 'Medium' ? '🟡' : '🟢';
      readme += `- ${emoji} **${priority} Priority**: ${count} papers\n`;
    });

    readme += `
## Quick Actions
- [📋 View Detailed Progress Report](./reports/detailed-progress.md)
- [📊 Weekly Summary](./reports/weekly-summary.md)
- [📈 Monthly Highlights](./reports/monthly-highlights.md)
- [🔄 Update Status](../../actions) (Run "Update Project Status" workflow)

## Repository Management
- **Naming Convention**: \`paper-[topic]-[year]\` or descriptive name
- **Required Files**: README.md, progress.md in papers/ folder
- **Topics**: Use GitHub topics for categorization
- **Status Tracking**: Via standardized progress.md files

---

*This dashboard is automatically updated by GitHub Actions. For manual updates or issues, check the [workflow logs](../../actions).*`;

    await fs.writeFile('README.md', readme);
  }

  async generateDetailedReport() {
    console.log('📊 Generating detailed progress report...');
    
    await fs.mkdir('reports', { recursive: true });
    
    let report = `# Detailed Progress Report
*Generated: ${new Date().toISOString()}*

## All Projects Overview

| Paper | Status | Priority | Progress | Links | Last Updated |
|-------|--------|----------|----------|-------|--------------|
`;

    this.papers.forEach(paper => {
      const statusEmoji = this.getStatusEmoji(paper.status);
      const priorityEmoji = paper.priority === 'High' ? '🔴' : paper.priority === 'Medium' ? '🟡' : '🟢';
      const progressBar = this.generateProgressBar(paper.progress.phase || []);
      
      const links = [];
      if (paper.preprintLink) {
        links.push(`[Preprint](${paper.preprintLink})`);
      }
      if (paper.publishedLink) {
        links.push(`[Published](${paper.publishedLink})`);
      }
      links.push(`[Repo](${paper.url})`);
      
      report += `| [${paper.fullName}](${paper.url}) | ${statusEmoji} ${paper.status} | ${priorityEmoji} ${paper.priority} | ${progressBar} | ${links.join(' • ')} | ${new Date(paper.lastUpdated).toLocaleDateString()} |\n`;
    });

    report += `
## Detailed Project Information

`;

    // Group papers by repository
    const papersByRepo = {};
    this.papers.forEach(paper => {
      if (!papersByRepo[paper.repoName]) {
        papersByRepo[paper.repoName] = [];
      }
      papersByRepo[paper.repoName].push(paper);
    });

    Object.entries(papersByRepo).forEach(([repoName, papers]) => {
      report += `### 📁 Repository: [${repoName}](${papers[0].repoUrl})\n`;
      
      if (papers.length === 1 && !papers[0].isSubpaper) {
        // Single paper repository
        const paper = papers[0];
        report += `- **Description**: ${paper.description}
- **Status**: ${this.getStatusEmoji(paper.status)} ${paper.status}
- **Priority**: ${paper.priority}
- **Topics**: ${paper.topics.join(', ') || 'None'}
- **Weekly Commits**: ${paper.commits || 0}
${paper.preprintLink ? `- **Preprint**: ${paper.preprintLink}` : ''}
${paper.publishedLink ? `- **Published**: ${paper.publishedLink}` : ''}
${paper.private ? '- **Visibility**: Private Repository' : ''}

`;
      } else {
        // Multi-paper repository
        report += `*Contains ${papers.length} papers:*\n\n`;
        papers.forEach(paper => {
          report += `#### ${this.getStatusEmoji(paper.status)} ${paper.paperName}
- **Status**: ${paper.status} | **Priority**: ${paper.priority}
- **Progress**: ${this.generateProgressBar(paper.progress.phase || [])}
${paper.preprintLink ? `- **Preprint**: ${paper.preprintLink}` : ''}
${paper.publishedLink ? `- **Published**: ${paper.publishedLink}` : ''}
- **Link**: [View Paper](${paper.url})

`;
        });
      }
    });

    await fs.writeFile('reports/detailed-progress.md', report);
  }

  generateProgressBar(completedPhases) {
    const totalPhases = 12; // Based on typical research phases
    const completed = completedPhases.length;
    const percentage = Math.round((completed / totalPhases) * 100);
    
    const filledBlocks = Math.round((completed / totalPhases) * 10);
    const emptyBlocks = 10 - filledBlocks;
    
    return `${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)} ${percentage}%`;
  }

  getStatusEmoji(status) {
    const emojis = {
      'Active': '🟢',
      'Planning': '🟡',
      'Review': '🔵',
      'Complete': '✅',
      'Stale': '🔴',
      'Inactive': '⚪'
    };
    return emojis[status] || '❓';
  }

  async saveData() {
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile('data/papers.json', JSON.stringify(this.papers, null, 2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats, null, 2));
  }

  async run() {
    console.log('🚀 Starting Scientific Visions Tracker...');
    
    await this.discoverPapers();
    this.generateStats();
    await this.updateReadme();
    await this.generateDetailedReport();
    await this.saveData();
    
    console.log('✅ Project status updated successfully!');
    console.log(`📊 Processed ${this.stats.total} papers`);
    console.log(`📈 ${this.stats.weeklyCommits} commits this week`);
  }
}

// Run the tracker
const tracker = new ScientificVisionsTracker();
tracker.run().catch(console.error);