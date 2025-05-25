const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;
const path = require('path');

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN // This will be set by the GitHub Actions workflow
    });
    this.owner = process.env.GITHUB_OWNER; // Owner of the hub repository, primary scan target
    this.repoFullName = process.env.GITHUB_REPOSITORY; // Full name of the hub repository "owner/repo"
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
    
    const targets = [
      { type: 'user', name: this.owner },
      // Example: Add more organizations/users to scan
      // { type: 'org', name: 'your-research-org' },
      // { type: 'user', name: 'collaborator-username' }
    ];
    
    let discoveredCount = 0;
    try {
      for (const target of targets) {
        console.log(`📡 Scanning ${target.type}: ${target.name}`);
        
        const { data: repos } = target.type === 'org' 
          ? await this.octokit.rest.repos.listForOrg({
              org: target.name,
              type: 'all', // Ensure 'all' to see private repos if token has access
              per_page: 100
            })
          : await this.octokit.rest.repos.listForUser({
              username: target.name,
              type: 'all', // Ensure 'all' to see private repos if token has access
              per_page: 100
            });

        for (const repo of repos) {
          if (await this.is100SVRepository(repo)) {
            const paperList = await this.analyzePaper(repo);
            if (paperList && paperList.length > 0) {
              this.papers.push(...paperList);
              discoveredCount += paperList.length;
            }
          } else {
            // console.log(`ℹ️  Skipping ${repo.name} as it's not identified as a 100SV repository.`);
          }
        }
      }

      console.log(`📊 Found ${discoveredCount} paper items across ${this.papers.length} relevant repository structures.`);
      this.papers.sort((a,b) => a.fullName.localeCompare(b.fullName)); // Sort papers for consistent output
    } catch (error) {
      console.error(`❌ Error discovering papers: ${error.message}`, error.stack);
    }
  }

  async is100SVRepository(repo) {
    // Method 1 (Primary): Check for 100SV.md identifier file in root
    try {
      await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: '100SV.md'
      });
      console.log(`✅ Identified ${repo.owner.login}/${repo.name} via 100SV.md`);
      return true;
    } catch (error) { /* File not found, try next method */ }

    // Method 2 (Secondary): Check for specific topic tag
    if (repo.topics && repo.topics.includes('100-scientific-visions')) {
      console.log(`✅ Identified ${repo.owner.login}/${repo.name} via '100-scientific-visions' topic tag`);
      return true;
    }

    // console.log(`ℹ️  Skipping ${repo.owner.login}/${repo.name} - no 100SV.md or required topic found.`);
    return false;
  }

  // The hasPapersFolder method might still be useful internally for analyzeSinglePaper/analyzeSubpaper
  // when deciding if it *can* parse progress, but not for initial identification.
  // You can remove it if it's no longer called by is100SVRepository and not needed elsewhere.
  // For now, I'll assume it might be used by analyzePaper logic later.
  async hasPapersFolder(repo) {
    try {
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: '' // Get root contents
      });
      return contents.some(item => item.type === 'dir' && item.name === 'papers');
    } catch (error) {
      // console.warn(`⚠️ Could not check for papers folder in ${repo.owner.login}/${repo.name}: ${error.message}`);
      return false;
    }
  }

  async getHistoricalStats(repo) {
    try {
      const createdAt = new Date(repo.created_at);
      const now = new Date();
      const ageInDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      
      let totalCommits3Months = 0;
      if (!repo.private) {
        try {
          const threeMonthsAgo = new Date();
          threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

          const { data: commits } = await this.octokit.rest.repos.listCommits({
            owner: repo.owner.login,
            repo: repo.name,
            since: threeMonthsAgo.toISOString(),
            per_page: 1 // We only need to know if there are any, but full count is also useful
          });
          // To get full count, would need to paginate or fetch up to 100.
          // For simplicity, let's assume this gives a sample or if small, total.
          // A more robust way:
          const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repo.owner.login,
            repo: repo.name,
            since: threeMonthsAgo.toISOString(),
            per_page: 100,
          });
          for await (const { data: commitPage } of iterator) {
            totalCommits3Months += commitPage.length;
          }

        } catch (error) {
          console.log(`⚠️  Cannot access 3-month commit history for public repo ${repo.name}: ${error.message}`);
        }
      } else {
          console.log(`ℹ️  Skipping 3-month commit history for private repo ${repo.name}`);
      }

      return {
        age: ageInDays,
        totalCommits3Months,
        createdAt: repo.created_at
      };
    } catch (error) {
      console.error(`❌ Error getting historical stats for ${repo.name}: ${error.message}`);
      return null;
    }
  }

  async analyzePaper(repo) {
    try {
      console.log(`🔬 Analyzing repository ${repo.owner.login}/${repo.name}...`);
      const papersList = [];
      const subpapers = await this.findSubpapers(repo);
      
      if (subpapers.length > 0) {
        console.log(`  Found ${subpapers.length} potential sub-paper structures in ${repo.name}.`);
        for (const subpaper of subpapers) {
          const paperData = await this.analyzeSubpaper(repo, subpaper);
          if (paperData) papersList.push(paperData);
        }
      } else {
        console.log(`  Analyzing ${repo.name} as a single-paper structure.`);
        const paperData = await this.analyzeSinglePaper(repo);
        if (paperData) papersList.push(paperData);
      }
      return papersList;
    } catch (error) {
      console.error(`❌ Error analyzing ${repo.name}: ${error.message}`);
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
        (item.name.match(/^P\d+$/) || item.name.match(/^[A-Z]{2,4}$/) || item.name.length <= 10) // Adjusted pattern
      );
      return subdirs.map(dir => dir.name);
    } catch (error) {
      // If 'papers' dir doesn't exist or other error, assume no subpapers of this type.
      return [];
    }
  }

  async parseFileContent(owner, repoName, filePath) {
    try {
      const { data: file } = await this.octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: filePath
      });
      if (file.content) {
        return Buffer.from(file.content, 'base64').toString();
      }
    } catch (error) {
      // console.log(`ℹ️  File not found or not accessible: ${filePath} in ${owner}/${repoName}`);
    }
    return null;
  }
  
  async analyzeSubpaper(repo, subpaperDir) {
    console.log(`  Analyzing sub-paper: ${repo.name}/${subpaperDir}`);
    const paper = {
      repoName: repo.name,
      paperName: subpaperDir,
      fullName: `${repo.name}/${subpaperDir}`,
      description: repo.description || 'No repository description.',
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`, // Assumes main branch
      repoUrl: repo.html_url,
      private: repo.private,
      topics: repo.topics || [],
      lastUpdated: repo.updated_at, // Repo last updated, could refine to sub-folder if needed
      status: 'Unknown',
      priority: 'Medium',
      progress: {},
      commits: 0, // Commits are repo-level, not easily attributable to sub-folders via basic API
      title: null, // Paper title
      preprintLink: null,
      publishedLink: null,
      isSubpaper: true,
      projectId: null,
      researchArea: null
    };

    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, 'papers/progress.md');
    if (progressContent) {
    paper.progress = this.parseProgress(progressContent);
    paper.status = paper.progress.status || 'Unknown';
    paper.priority = paper.progress.priority || 'Medium';
    paper.preprintLink = paper.progress.preprintLink;
    paper.publishedLink = paper.progress.publishedLink;
    if (paper.progress.title) { // Check if title was parsed
        paper.title = paper.progress.title;
        paper.paperName = paper.progress.title; // Make paperName more descriptive
    }
    }

    const svContent = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/100SV.md`);
    if (svContent) {
        const svData = this.parse100SV(svContent);
        paper.description = svData.researchFocus || paper.description; // Prefer 100SV focus if available
        paper.projectId = svData.projectId;
        paper.researchArea = svData.researchArea;
    }
    
    if (paper.status === 'Unknown' && !progressContent) { // Only infer if no progress.md
        paper.status = this.inferStatusFromActivity(repo, `papers/${subpaperDir}`);
    }

    return paper;
  }

  async analyzeSinglePaper(repo) {
    console.log(`  Analyzing single-paper: ${repo.name}`);
    const paper = {
      repoName: repo.name,
      paperName: repo.name, // Or a more specific name if parsable from 100SV.md root
      fullName: repo.name,
      description: repo.description || 'No description.',
      url: repo.html_url,
      repoUrl: repo.html_url,
      private: repo.private,
      topics: repo.topics || [],
      lastUpdated: repo.updated_at,
      status: 'Unknown',
      priority: 'Medium',
      progress: {},
      commits: 0, // Weekly commits for this repo
      title: null, // Add new field
      preprintLink: null,
      publishedLink: null,
      isSubpaper: false,
      projectId: null,
      researchArea: null
    };

    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/progress.md`);
    if (progressContent) {
    paper.progress = this.parseProgress(progressContent);
    paper.status = paper.progress.status || 'Unknown';
    paper.priority = paper.progress.priority || 'Medium';
    paper.preprintLink = paper.progress.preprintLink; 
    paper.publishedLink = paper.progress.publishedLink;
    if (paper.progress.title) { // Check if title was parsed
        paper.title = paper.progress.title;
        paper.paperName = paper.progress.title; // Make paperName more descriptive
    }
    }

    const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
    if (svContentRoot) {
        const svData = this.parse100SV(svContentRoot);
        // If paperName is just repo name, maybe override with a title from researchFocus?
        paper.description = svData.researchFocus || paper.description; // Prefer 100SV focus
        paper.projectId = svData.projectId;
        paper.researchArea = svData.researchArea;
    }
    
    if (paper.status === 'Unknown' && !progressContent) { // Only infer if no progress.md
        paper.status = this.inferStatusFromActivity(repo, 'papers/');
    }

    const historicalStats = await this.getHistoricalStats(repo);
    if (historicalStats) {
      paper.historical = historicalStats;
      paper.projectAge = historicalStats.age; // days
      paper.total3MonthCommits = historicalStats.totalCommits3Months;
    }

    // Get recent commit activity for the repo (public repos primarily)
    if (!repo.private) {
      try {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        let weeklyRepoCommits = 0;
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repo.owner.login,
            repo: repo.name,
            since: weekAgo.toISOString(),
            per_page: 100,
          });
        let firstCommitMessage = null;
        for await (const { data: commitsPage } of iterator) {
            if (commitsPage.length > 0 && !firstCommitMessage) {
                firstCommitMessage = commitsPage[0].commit.message.split('\n')[0]; // First line only
            }
            weeklyRepoCommits += commitsPage.length;
        }

        paper.commits = weeklyRepoCommits; // weekly commits for this repo
        this.stats.weeklyCommits += weeklyRepoCommits;

        if (weeklyRepoCommits > 0) {
          this.stats.recentActivity.push({
            repo: paper.fullName,
            commits: weeklyRepoCommits,
            lastCommit: firstCommitMessage || "N/A"
          });
        }
      } catch (error) {
        console.log(`⚠️  Cannot access weekly commit data for public repo ${repo.name}: ${error.message}`);
      }
    } else {
        console.log(`ℹ️  Skipping weekly commit data for private repo ${repo.name}`);
    }
    return paper;
  }

parseProgress(content) {
    const progress = {
        title: null, // New field for paper title
        status: null, 
        priority: null, 
        phase: [], 
        preprintLink: null, 
        publishedLink: null
    };

    // Extract Paper Title
    const titleMatch = content.match(/^\*\*Paper Title\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (titleMatch) {
        progress.title = titleMatch[1].trim();
    }

    const statusMatch = content.match(/\*\*Status\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (statusMatch) progress.status = statusMatch[1].trim();

    const priorityMatch = content.match(/\*\*Priority\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (priorityMatch) progress.priority = priorityMatch[1].trim();
    
    const preprintMatch = content.match(/(?:\*\*Preprint\*\*|\*\*arXiv\*\*):\s*([^\s(\[]+)/im) || content.match(/(?:\*\*Preprint\*\*|\*\*arXiv\*\*):\s*\[[^\]]+\]\(([^)]+)\)/im);
    if (preprintMatch && preprintMatch[1] && !preprintMatch[1].startsWith('[Link')) progress.preprintLink = preprintMatch[1].trim();

    const publishedMatch = content.match(/(?:\*\*Published\*\*|\*\*DOI\*\*):\s*([^\s(\[]+)/im) || content.match(/(?:\*\*Published\*\*|\*\*DOI\*\*):\s*\[[^\]]+\]\(([^)]+)\)/im);
    if (publishedMatch && publishedMatch[1] && !publishedMatch[1].startsWith('[DOI')) progress.publishedLink = publishedMatch[1].trim();

    const phaseMatches = content.match(/- \[x\]\s*([^\n]+)/gim);
    if (phaseMatches) {
      progress.phase = phaseMatches.map(match => match.replace(/- \[x\]\s*/i, '').trim());
    }
    
    // Default if not found
    if (!progress.status) progress.status = 'Unknown';
    if (!progress.priority) progress.priority = 'Medium';

    return progress;
}

  parse100SV(content) {
    const svData = { projectId: null, researchArea: null, researchFocus: null };

    const idMatch = content.match(/\*\*Project ID\*\*:\s*\[?([^\]\n]+?)\]?/im);
    if (idMatch) svData.projectId = idMatch[1].trim();

    const areaMatch = content.match(/\*\*Research Area\*\*:\s*\[?([^\]\n]+?)\]?/im);
    if (areaMatch) svData.researchArea = areaMatch[1].trim();

    const focusMatch = content.match(/## Research Focus\s*\n+([\s\S]*?)(?=\n##|\n---|\n\*{3,}|$)/im);
    if (focusMatch) svData.researchFocus = focusMatch[1].trim().split('\n')[0]; // First line of focus

    return svData;
  }

  async inferStatusFromActivity(repo, specificPath = null) {
    // Try to get last commit date for a specific path if provided
    let lastCommitDate = repo.updated_at; // Default to repo update time
    if (specificPath && !repo.private) { // Path-specific commits are harder for private without full clone
        try {
            const { data: commits } = await this.octokit.rest.repos.listCommits({
                owner: repo.owner.login,
                repo: repo.name,
                path: specificPath,
                per_page: 1
            });
            if (commits.length > 0) {
                lastCommitDate = commits[0].commit.committer.date;
            }
        } catch (err) {
            // console.warn(`Could not get path-specific commits for ${repo.name}/${specificPath}: ${err.message}`);
        }
    }

    const daysSinceUpdate = Math.floor((new Date() - new Date(lastCommitDate)) / (1000 * 60 * 60 * 24));
    if (daysSinceUpdate < 7) return 'Active';
    if (daysSinceUpdate < 30) return 'Recent';
    if (daysSinceUpdate < 90) return 'Inactive';
    return 'Stale';
  }

  generateStats() {
    this.stats.total = this.papers.length;
    this.stats.byStatus = {};
    this.papers.forEach(paper => {
      this.stats.byStatus[paper.status] = (this.stats.byStatus[paper.status] || 0) + 1;
    });

    this.stats.byPriority = {};
    this.papers.forEach(paper => {
      this.stats.byPriority[paper.priority] = (this.stats.byPriority[paper.priority] || 0) + 1;
    });

    this.stats.recentActivity.sort((a, b) => b.commits - a.commits);
    this.stats.recentActivity = this.stats.recentActivity.slice(0, 10); // Top 10
  }

  async updateReadme() {
    console.log('📝 Updating main README.md...');
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    
    let dashboardUrl = `https://${this.owner}.github.io/${this.repoFullName.split('/')[1]}/`;
    if (!this.repoFullName || !this.repoFullName.includes('/')) {
        dashboardUrl = `<!-- Warning: GITHUB_REPOSITORY env var not set correctly. Update this link manually. Expected format: owner/repo -->`;
        if (this.repoFullName) { // e.g. only repo name was passed
            dashboardUrl = `https://[YOUR_USERNAME_OR_ORG].github.io/${this.repoFullName}/`;
        }
    }


    let readme = `# 100 Scientific Visions by Daniel Sandner

## Project Overview
A comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.

## Current Status Dashboard
*Last updated: ${timestamp}*

### Quick Stats
- 📊 **Total Papers Tracked**: ${this.stats.total}
- 🟢 **Active Projects**: ${this.stats.byStatus['Active'] || 0}
- 🟡 **In Planning**: ${this.stats.byStatus['Planning'] || 0}
- 🔴 **Stale (Needs Attention)**: ${this.stats.byStatus['Stale'] || 0}
- 📈 **This Week's Commits (Public Repos)**: ${this.stats.weeklyCommits}

### Recent Activity (Top 10 Public Repos by Weekly Commits)
`;

    if (this.stats.recentActivity.length > 0) {
      this.stats.recentActivity.forEach(activity => {
        readme += `- **${activity.repo}**: ${activity.commits} commits - "${activity.lastCommit}"\n`;
      });
    } else {
      readme += '*No recent commit activity detected in public repositories or data unavailable.*\n';
    }

    readme += `
## Research Areas
*Categorization based on repository topics or 'Research Area' in 100SV.md files.*

### By Status
`;
    const sortedStatusKeys = Object.keys(this.stats.byStatus).sort();
    sortedStatusKeys.forEach(status => {
      readme += `- **${status}**: ${this.stats.byStatus[status]} papers\n`;
    });

    readme += `
### Priority Distribution
`;
    const sortedPriorityKeys = Object.keys(this.stats.byPriority).sort((a,b) => {
        const order = { High: 0, Medium: 1, Low: 2 }; // Custom sort order
        return (order[a] ?? 99) - (order[b] ?? 99);
    });
    sortedPriorityKeys.forEach(priority => {
      const emoji = priority === 'High' ? '🔴' : priority === 'Medium' ? '🟡' : '🟢';
      readme += `- ${emoji} **${priority} Priority**: ${this.stats.byPriority[priority]} papers\n`;
    });

    readme += `
## Quick Actions & Links
- [📊 Interactive Dashboard](${dashboardUrl})
- [📋 View Detailed Progress Report](./reports/detailed-progress.md)
- [🔄 Update Status Manually](../../actions) (Run "Update Project Status" workflow)

## About This System
This dashboard is automatically updated by GitHub Actions. For more information on setup, repository identification, and customization, see [SETUP.md](./setup.md).

---

*This dashboard is part of the 100 Scientific Visions initiative by Daniel Sandner.*`;

    await fs.writeFile('README.md', readme);
    console.log('✅ README.md updated successfully.');
  }

  async generateDetailedReport() {
    console.log('📊 Generating detailed progress report...');
    try {
      await fs.mkdir('reports', { recursive: true });
    
      const now = new Date();
      const generatedDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const generatedTime = now.toTimeString().slice(0, 8); // HH:MM:SS

      let report = `# Detailed Progress Report\n`;
      report += `*Generated: ${generatedDate} ${generatedTime} UTC*\n\n`;
      report += `## All Tracked Paper Items (${this.papers.length} total)\n\n`;

      report += `| Title / Location                 | Status                      | Priority                      | Progress                               | Links                                     | Last Repo Update |\n`;
      report += `|:---------------------------------|:----------------------------|:------------------------------|:---------------------------------------|:------------------------------------------|:-----------------|\n`; // Markdown table alignment

      if (this.papers.length === 0) {
        report += `| *No paper items found or tracked.* | - | - | - | - | - |\n`;
      }

      this.papers.forEach(paper => {
        const statusEmoji = this.getStatusEmoji(paper.status);
        const priorityEmoji = paper.priority === 'High' ? '🔴' : paper.priority === 'Medium' ? '🟡' : '🟢';
        const progressBar = this.generateProgressBar(paper.progress?.phase || []);
        
        const links = [];
        if (paper.preprintLink && paper.preprintLink !== 'null' && !paper.preprintLink.toLowerCase().includes('[link')) {
          links.push(`[Preprint](${paper.preprintLink})`);
        }
        if (paper.publishedLink && paper.publishedLink !== 'null' && !paper.publishedLink.toLowerCase().includes('[doi')) {
          links.push(`[Published](${paper.publishedLink})`);
        }
        links.push(`[View](${paper.url})`); // Link to sub-paper dir or repo root
        
        // Determine the best display name
        let displayName = paper.title || paper.paperName; // Use parsed title first
        if (!paper.title && paper.isSubpaper) { // If no title and it's a subpaper, paperName is subDir
             // displayName is already subpaperDir (paper.paperName)
        } else if (!paper.title && !paper.isSubpaper) { // No title, single paper repo, paperName is repoName
             // displayName is already repoName (paper.paperName)
        }

        let locationHint = paper.fullName; // Default to full path
        // If title is present and different from paperName (which might be a slug/dir name)
        // Or if the display name is the repo name for a single paper repo
        if ((paper.title && paper.title !== paper.paperName) || (!paper.isSubpaper && displayName === paper.repoName)) {
            // For subpapers with a title, fullName is still good for context
            // For single papers with a title, no need to repeat repoName if title is distinct
            if (paper.isSubpaper) {
                locationHint = `<br><small>(${paper.fullName})</small>`;
            } else {
                locationHint = ''; // Title is sufficient, fullName is just repoName
            }
        } else if (paper.isSubpaper) {
             // If no title, paperName (subDir) is the primary name, fullName gives context
            locationHint = `<br><small>(${paper.repoName}/${paper.paperName})</small>`;
        } else {
            locationHint = ''; // Single paper, paperName is repoName, no extra hint needed
        }


        report += `| **${displayName}**${locationHint} | ${statusEmoji} ${paper.status} | ${priorityEmoji} ${paper.priority} | \`${progressBar}\` | ${links.join(' • ')} | ${new Date(paper.lastUpdated).toLocaleDateString()} |\n`;
      });

      report += `\n## Detailed Information by Repository\n`;

      const papersByRepo = this.papers.reduce((acc, paper) => {
          (acc[paper.repoName] = acc[paper.repoName] || []).push(paper);
          return acc;
      }, {});

      if (Object.keys(papersByRepo).length === 0 && this.papers.length > 0) {
          report += `*Error: Papers were found, but could not be grouped by repository for detail section.*\n`;
      } else if (Object.keys(papersByRepo).length === 0) {
          report += `*No repositories to detail.*\n`;
      }


      Object.keys(papersByRepo).sort().forEach(repoName => {
          const papersInRepo = papersByRepo[repoName];
          const repoData = papersInRepo[0]; // Use first paper for common repo data like repoUrl, description from repo

          report += `\n### 📁 Repository: [${repoName}](${repoData.repoUrl})\n`;
          report += `- **Repo Description**: ${repoData.description || 'N/A (No repo description or 100SV.md research focus)'}\n`;
          report += `- **Topics**: ${repoData.topics.join(', ') || 'None'}\n`;
          report += `- **Visibility**: ${repoData.private ? 'Private' : 'Public'}\n`;
          if (repoData.historical) {
              report += `- **Created**: ${new Date(repoData.historical.createdAt).toLocaleDateString()} (${repoData.historical.age} days ago)\n`;
              if (!repoData.private && typeof repoData.historical.totalCommits3Months === 'number') {
                report += `- **Commits (last 3 months)**: ${repoData.historical.totalCommits3Months}\n`;
              }
          }
          // Weekly commits are for the whole repo, usually stored on single-paper or first sub-paper instance
          if (!repoData.private && typeof repoData.commits === 'number' && repoData.commits > 0) {
              report += `- **Weekly Commits (repo)**: ${repoData.commits}\n`;
          }


          if (papersInRepo.length === 1 && !papersInRepo[0].isSubpaper) {
              // Single paper repository, details are for this paper
              const paper = papersInRepo[0];
              report += `- **Paper Title**: ${paper.title || paper.paperName || '*Not specified*'}\n`;
              report += `- **Status**: ${this.getStatusEmoji(paper.status)} ${paper.status}\n`;
              report += `- **Priority**: ${paper.priority}\n`;
              report += `- **Progress**: \`${this.generateProgressBar(paper.progress?.phase || [])}\`\n`;
              if (paper.projectId) report += `- **Project ID**: ${paper.projectId}\n`;
              if (paper.researchArea) report += `- **Research Area**: ${paper.researchArea}\n`;
              if (paper.preprintLink && paper.preprintLink !== 'null') report += `- **Preprint**: [Link](${paper.preprintLink})\n`;
              if (paper.publishedLink && paper.publishedLink !== 'null') report += `- **Published**: [Link](${paper.publishedLink})\n`;
          } else {
              // Multi-paper repository
              report += `\n  *Contains ${papersInRepo.length} paper items:*\n`;
              papersInRepo.forEach(paper => {
                  report += `  - #### ${this.getStatusEmoji(paper.status)} ${paper.title || paper.paperName || '*Untitled Sub-paper*'}\n`;
                  if (paper.title && paper.paperName !== paper.title) { // If title is different from dir name
                    report += `    - **Location**: \`papers/${paper.paperName}\`\n`;
                  }
                  report += `    - **Status**: ${paper.status} | **Priority**: ${paper.priority}\n`;
                  report += `    - **Progress**: \`${this.generateProgressBar(paper.progress?.phase || [])}\`\n`;
                  if (paper.projectId) report += `    - **Project ID**: ${paper.projectId}\n`;
                  if (paper.researchArea) report += `    - **Research Area**: ${paper.researchArea}\n`;
                  if (paper.preprintLink && paper.preprintLink !== 'null') report += `    - **Preprint**: [Link](${paper.preprintLink})\n`;
                  if (paper.publishedLink && paper.publishedLink !== 'null') report += `    - **Published**: [Link](${paper.publishedLink})\n`;
                  report += `    - **Link**: [View Paper Directory](${paper.url})\n\n`;
              });
          }
          report += `\n---\n`; // Separator between repositories
      });

      await fs.writeFile('reports/detailed-progress.md', report);
      console.log('✅ Detailed report generated successfully: reports/detailed-progress.md');
    } catch (error) {
      console.error(`❌ Error generating detailed report: ${error.message}`, error.stack);
    }
  }

  generateProgressBar(completedPhases) {
    const totalPhases = 12; // From progress.md template
    const completed = Array.isArray(completedPhases) ? completedPhases.length : 0;
    const percentage = Math.round((completed / totalPhases) * 100);
    const filledBlocks = Math.round((completed / totalPhases) * 10);
    const emptyBlocks = 10 - filledBlocks;
    return `${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)} ${percentage}%`;
  }

  getStatusEmoji(status) {
    const emojis = {
      'Active': '🟢', 'Planning': '🟡', 'Review': '🔵', 'Complete': '✅',
      'Stale': '🔴', 'Inactive': '⚪', 'Recent': '🟠', 'Analysis': '🟣', 
      'Writing': '✍️', 'On-Hold': '⏸️', 'Unknown': '❓'
    };
    return emojis[status] || '❓';
  }

  async saveData() {
    console.log('💾 Saving data to JSON files...');
    await fs.mkdir('data', { recursive: true });
    // Sort papers before saving for consistent JSON output (diffs)
    const sortedPapers = [...this.papers].sort((a, b) => a.fullName.localeCompare(b.fullName));
    await fs.writeFile('data/papers.json', JSON.stringify(sortedPapers, null, 2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats, null, 2));
    console.log('✅ Data saved to data/papers.json and data/stats.json.');
  }

  async run() {
    console.log('🚀 Starting Scientific Visions Tracker...');
    if (!this.owner) {
        console.error("❌ GITHUB_OWNER environment variable is not set. Cannot determine scan targets.");
        return;
    }
    if (!this.repoFullName) {
        console.warn("⚠️ GITHUB_REPOSITORY environment variable is not set. Dashboard link in README may be incorrect.");
    }
    
    await this.discoverPapers();
    this.generateStats();
    await this.updateReadme();
    await this.generateDetailedReport();
    await this.saveData();
    
    console.log('🎉 Project status updated successfully!');
    console.log(`📊 Processed ${this.stats.total} paper items.`);
    console.log(`📈 ${this.stats.weeklyCommits} commits this week across relevant public repositories.`);
  }
}

(async () => {
  const tracker = new ScientificVisionsTracker();
  try {
    await tracker.run();
  } catch (error) {
    console.error("❌ Unhandled error in tracker execution:", error);
    process.exit(1);
  }
})();