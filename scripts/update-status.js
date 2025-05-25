const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;
// const path = require('path'); // Not strictly necessary for this script's direct operations

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.owner = process.env.GITHUB_OWNER;
    this.repoFullName = process.env.GITHUB_REPOSITORY; // e.g., "owner/repo-name"
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [],
      weeklyCommits: 0
    };
  }

  async parseFileContent(owner, repoName, filePath) {
    // console.log(`DEBUG: Attempting to read file: ${owner}/${repoName}/${filePath}`);
    try {
      const { data: file } = await this.octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: filePath
      });
      if (file.content) {
        const content = Buffer.from(file.content, 'base64').toString();
        // console.log(`DEBUG: Content found for ${filePath}, length: ${content.length}`);
        return content;
      }
      // console.log(`DEBUG: File ${filePath} has no content field.`);
    } catch (error) {
      // console.log(`DEBUG: File not found or not accessible: ${filePath} in ${owner}/${repoName} (Error: ${error.message})`);
    }
    return null;
  }

  parseProgress(content) {
    // console.log(`DEBUG: Parsing progress.md content snippet:\n---\n${content.substring(0, 300)}\n---`);
    const progress = {
      title: null,
      status: null,
      priority: null,
      phase: [],
      preprintLink: null,
      publishedLink: null
    };

    const titleMatch = content.match(/^\*\*Paper Title\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (titleMatch && titleMatch[1]) {
        progress.title = titleMatch[1].trim();
        // console.log(`DEBUG: Matched Title: '${progress.title}'`);
    }

    const statusMatch = content.match(/\*\*Status\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (statusMatch && statusMatch[1]) {
      progress.status = statusMatch[1].trim();
      // console.log(`DEBUG: Matched Status: '${progress.status}'`);
    }

    const priorityMatch = content.match(/\*\*Priority\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (priorityMatch && priorityMatch[1]) {
      progress.priority = priorityMatch[1].trim();
      // console.log(`DEBUG: Matched Priority: '${progress.priority}'`);
    }
    
    const preprintRegex = /(?:\*\*Preprint\*\*|\*\*arXiv\*\*):\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s(\[]+))/im;
    const preprintMatchResult = content.match(preprintRegex);
    if (preprintMatchResult) {
        const urlFromMarkdown = preprintMatchResult[1]; 
        const directUrl = preprintMatchResult[2];       
        const potentialLink = (urlFromMarkdown || directUrl || '').trim();
        if (potentialLink && !potentialLink.toLowerCase().startsWith('[link')) {
            progress.preprintLink = potentialLink;
            // console.log(`DEBUG: Matched Preprint Link: '${progress.preprintLink}'`);
        }
    }

    const publishedRegex = /(?:\*\*Published\*\*|\*\*DOI\*\*):\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s(\[]+))/im;
    const publishedMatchResult = content.match(publishedRegex);
    if (publishedMatchResult) {
        const urlFromMarkdown = publishedMatchResult[1];
        const directUrl = publishedMatchResult[2];
        const potentialLink = (urlFromMarkdown || directUrl || '').trim();
        if (potentialLink && !potentialLink.toLowerCase().startsWith('[doi')) {
            progress.publishedLink = potentialLink;
            // console.log(`DEBUG: Matched Published Link: '${progress.publishedLink}'`);
        }
    }

    const phaseMatches = content.match(/- \[x\]\s*([^\n]+)/gim);
    if (phaseMatches) {
      progress.phase = phaseMatches.map(match => match.replace(/- \[x\]\s*/i, '').trim());
    }
    
    return progress;
  }
  
  parse100SV(content) {
    const svData = { projectId: null, researchArea: null, researchFocus: null };

    const idMatch = content.match(/\*\*Project ID\*\*:\s*\[?([^\]\n]+?)\]?/im);
    if (idMatch && idMatch[1]) svData.projectId = idMatch[1].trim();

    const areaMatch = content.match(/\*\*Research Area\*\*:\s*\[?([^\]\n]+?)\]?/im);
    if (areaMatch && areaMatch[1]) svData.researchArea = areaMatch[1].trim();

    const focusMatch = content.match(/## Research Focus\s*\n+([\s\S]*?)(?=\n##|\n---|\n\*{3,}|$)/im);
    if (focusMatch && focusMatch[1]) svData.researchFocus = focusMatch[1].trim().split('\n')[0]; 

    return svData;
  }

  async analyzeSinglePaper(repo) {
    // console.log(`  Analyzing single-paper: ${repo.owner.login}/${repo.name}`);
    const paper = {
      repoName: repo.name,
      paperName: repo.name,
      fullName: repo.name,
      description: repo.description || 'No repository description.',
      url: repo.html_url,
      repoUrl: repo.html_url,
      private: repo.private,
      topics: repo.topics || [],
      lastUpdated: repo.updated_at,
      title: null,
      status: 'Unknown',
      priority: 'Medium',
      progress: { phase: [] }, // Ensure progress.phase is always an array
      commits: 0,
      preprintLink: null,
      publishedLink: null,
      isSubpaper: false,
      projectId: null,
      researchArea: null,
      historical: null,
    };

    const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
    if (svContentRoot) {
        const svData = this.parse100SV(svContentRoot);
        paper.description = svData.researchFocus || paper.description;
        paper.projectId = svData.projectId;
        paper.researchArea = svData.researchArea;
    }

    let titleFromProgressMd = null;
    let statusFromProgressMd = null;
    let priorityFromProgressMd = null;

    const progressFilePath = 'papers/progress.md';
    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, progressFilePath);
    // console.log(`DEBUG [${paper.fullName}]: progressContent for '${progressFilePath}' ${progressContent ? 'found' : 'NOT found'}`);


    if (progressContent) {
      const parsedProgress = this.parseProgress(progressContent);
      paper.progress = parsedProgress; 

      if (parsedProgress.title && parsedProgress.title.trim() !== '') {
          titleFromProgressMd = parsedProgress.title.trim();
      }
      if (parsedProgress.status && parsedProgress.status.trim() !== '') {
          statusFromProgressMd = parsedProgress.status.trim();
      }
      if (parsedProgress.priority && parsedProgress.priority.trim() !== '') {
          priorityFromProgressMd = parsedProgress.priority.trim();
      }
      paper.preprintLink = parsedProgress.preprintLink;
      paper.publishedLink = parsedProgress.publishedLink;
    }

    if (titleFromProgressMd) {
        paper.title = titleFromProgressMd;
        paper.paperName = titleFromProgressMd;
    }

    if (statusFromProgressMd) {
        paper.status = statusFromProgressMd;
    } else {
        paper.status = await this.inferStatusFromActivity(repo, 'papers/');
    }
    
    paper.priority = priorityFromProgressMd || 'Medium';

    const historicalStats = await this.getHistoricalStats(repo);
    if (historicalStats) {
      paper.historical = historicalStats; // Contains .age, .totalCommits3Months, .createdAt
    }

    if (!repo.private) {
      try {
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        let weeklyRepoCommits = 0;
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repo.owner.login, repo: repo.name, since: weekAgo.toISOString(), per_page: 100,
        });
        let firstCommitMessage = null;
        for await (const { data: commitsPage } of iterator) {
            if (commitsPage.length > 0 && !firstCommitMessage) firstCommitMessage = commitsPage[0].commit.message.split('\n')[0];
            weeklyRepoCommits += commitsPage.length;
        }
        paper.commits = weeklyRepoCommits;
        this.stats.weeklyCommits += weeklyRepoCommits;
        if (weeklyRepoCommits > 0) {
          this.stats.recentActivity.push({ repo: paper.fullName, commits: weeklyRepoCommits, lastCommit: firstCommitMessage || "N/A" });
        }
      } catch (error) { /* console.log(`⚠️  Cannot access weekly commit data for public repo ${repo.name}`); */ }
    }
    return paper;
  }

  async analyzeSubpaper(repo, subpaperDir) {
    // console.log(`  Analyzing sub-paper: ${repo.owner.login}/${repo.name}/${subpaperDir}`);
    const paper = {
      repoName: repo.name,
      paperName: subpaperDir,
      fullName: `${repo.name}/${subpaperDir}`,
      description: repo.description || 'No repository description.',
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`,
      repoUrl: repo.html_url,
      private: repo.private,
      topics: repo.topics || [],
      lastUpdated: repo.updated_at,
      title: null,
      status: 'Unknown',
      priority: 'Medium',
      progress: { phase: [] }, // Ensure progress.phase is always an array
      commits: 0, 
      preprintLink: null,
      publishedLink: null,
      isSubpaper: true,
      projectId: null,
      researchArea: null
    };

    const svContentSub = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/100SV.md`);
    if (svContentSub) {
        const svData = this.parse100SV(svContentSub);
        paper.description = svData.researchFocus || paper.description;
        paper.projectId = svData.projectId;
        paper.researchArea = svData.researchArea;
    } else {
        const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
        if (svContentRoot) {
            const svDataRoot = this.parse100SV(svContentRoot);
            if (!paper.projectId) paper.projectId = svDataRoot.projectId;
            if (!paper.researchArea) paper.researchArea = svDataRoot.researchArea;
            // If no sub-100SV.md researchFocus, and root 100SV.md has one, consider using it
            // This might be too aggressive if repo.description was already set and preferred.
            // Current logic: sub-100SV focus > repo description > (no explicit fallback to root focus for description here)
        }
    }

    let titleFromProgressMd = null;
    let statusFromProgressMd = null;
    let priorityFromProgressMd = null;

    const progressFilePath = `papers/${subpaperDir}/progress.md`;
    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, progressFilePath);
    // console.log(`DEBUG [${paper.fullName}]: progressContent for '${progressFilePath}' ${progressContent ? 'found' : 'NOT found'}`);

    if (progressContent) {
      const parsedProgress = this.parseProgress(progressContent);
      paper.progress = parsedProgress;

      if (parsedProgress.title && parsedProgress.title.trim() !== '') titleFromProgressMd = parsedProgress.title.trim();
      if (parsedProgress.status && parsedProgress.status.trim() !== '') statusFromProgressMd = parsedProgress.status.trim();
      if (parsedProgress.priority && parsedProgress.priority.trim() !== '') priorityFromProgressMd = parsedProgress.priority.trim();
      paper.preprintLink = parsedProgress.preprintLink;
      paper.publishedLink = parsedProgress.publishedLink;
    }

    if (titleFromProgressMd) {
        paper.title = titleFromProgressMd;
        paper.paperName = titleFromProgressMd;
    }

    if (statusFromProgressMd) {
        paper.status = statusFromProgressMd;
    } else {
        paper.status = await this.inferStatusFromActivity(repo, `papers/${subpaperDir}/`);
    }
    
    paper.priority = priorityFromProgressMd || 'Medium';
    // Note: paper.commits for subpapers is not separately calculated; it reflects repo-level activity.
    return paper;
  }

  async inferStatusFromActivity(repo, specificPath = null) {
    let lastCommitDateToUse = repo.updated_at; 
    if (specificPath && !repo.private) {
        try {
            const { data: commits } = await this.octokit.rest.repos.listCommits({
                owner: repo.owner.login, repo: repo.name, path: specificPath, per_page: 1
            });
            if (commits.length > 0 && commits[0].commit.committer && commits[0].commit.committer.date) {
                lastCommitDateToUse = commits[0].commit.committer.date;
            }
        } catch (err) { /* console.warn(`Could not get path-specific commits for ${repo.name}/${specificPath}.`); */ }
    }
    const daysSinceUpdate = Math.floor((new Date() - new Date(lastCommitDateToUse)) / (1000 * 60 * 60 * 24));
    if (daysSinceUpdate < 7) return 'Active';
    if (daysSinceUpdate < 30) return 'Recent';
    if (daysSinceUpdate < 90) return 'Inactive';
    return 'Stale';
  }
  
  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    const targets = [{ type: 'user', name: this.owner }]; 
    // Example: Add more targets:
    // targets.push({ type: 'org', name: 'your-research-org' });
    // targets.push({ type: 'user', name: 'collaborator-username' });
    
    let discoveredCount = 0;
    try {
      for (const target of targets) {
        // console.log(`📡 Scanning ${target.type}: ${target.name}`);
        const repoListParams = target.type === 'org' 
          ? { org: target.name, type: 'all', per_page: 100 }
          : { username: target.name, type: 'all', per_page: 100 };
        
        for await (const { data: reposPage } of this.octokit.paginate.iterator(
          target.type === 'org' ? this.octokit.rest.repos.listForOrg : this.octokit.rest.repos.listForUser,
          repoListParams
        )) {
          for (const repo of reposPage) {
            if (await this.is100SVRepository(repo)) {
              const paperList = await this.analyzePaper(repo);
              if (paperList && paperList.length > 0) {
                this.papers.push(...paperList);
                discoveredCount += paperList.length;
              }
            }
          }
        }
      }
      console.log(`📊 Found ${discoveredCount} paper items from ${this.papers.length} identified repository structures.`);
      this.papers.sort((a,b) => a.fullName.localeCompare(b.fullName));
    } catch (error) {
      console.error(`❌ Error discovering papers: ${error.message}`, error.stack);
    }
  }

  async is100SVRepository(repo) {
    try {
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: '100SV.md' });
      // console.log(`✅ Identified ${repo.owner.login}/${repo.name} via 100SV.md`);
      return true;
    } catch (error) { /* File not found, try next method */ }

    if (repo.topics && repo.topics.includes('100-scientific-visions')) {
      // console.log(`✅ Identified ${repo.owner.login}/${repo.name} via '100-scientific-visions' topic tag`);
      return true;
    }
    return false;
  }

  async hasPapersFolder(repo) { // Primarily used by findSubpapers
    try {
      const { data: contents } = await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers', request: {retries: 0} }); // check if 'papers' dir exists
      return Array.isArray(contents); // If it's a directory, contents will be an array
    } catch (error) {
      return false; // 'papers' directory likely doesn't exist or other access issue
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
          const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repo.owner.login, repo: repo.name, since: threeMonthsAgo.toISOString(), per_page: 100,
          });
          for await (const { data: commitPage } of iterator) { totalCommits3Months += commitPage.length; }
        } catch (error) { /* console.log(`⚠️  Cannot access 3-month commit history for public repo ${repo.name}`); */ }
      }
      return { age: ageInDays, totalCommits3Months, createdAt: repo.created_at };
    } catch (error) { console.error(`❌ Error getting historical stats for ${repo.name}: ${error.message}`); return null; }
  }
  
  async analyzePaper(repo) { // This is the main entry point for analyzing a repo after it's identified
    // console.log(`🔬 Analyzing repository ${repo.owner.login}/${repo.name}...`);
    const papersList = [];
    const subpaperDirs = await this.findSubpapers(repo); 
    
    if (subpaperDirs.length > 0) {
    //   console.log(`  Found ${subpaperDirs.length} potential sub-paper structures in ${repo.name}.`);
      for (const subpaperDir of subpaperDirs) {
        const paperData = await this.analyzeSubpaper(repo, subpaperDir);
        if (paperData) papersList.push(paperData);
      }
    } else {
    //   console.log(`  Analyzing ${repo.name} as a single-paper structure (no valid sub-paper dirs found in 'papers/').`);
      const paperData = await this.analyzeSinglePaper(repo);
      if (paperData) papersList.push(paperData);
    }
    return papersList;
  }

  async findSubpapers(repo) { // Finds subdirectories in 'papers/' that might represent individual papers
    const subpaperNames = [];
    if (!(await this.hasPapersFolder(repo))) {
        // console.log(`DEBUG [${repo.name}]: No 'papers' folder found, or it's not a directory.`);
        return subpaperNames; // No 'papers' folder, so no subpapers
    }
    try {
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: 'papers'
      });
      if (Array.isArray(contents)) {
        for (const item of contents) {
            // Basic check: is it a directory? More specific naming conventions can be added.
            if (item.type === 'dir') { 
                // You might want more specific checks for subdir names here, e.g.,
                // if (item.name.match(/^P\d+$/) || item.name.match(/^[A-Z]{2,4}$/) || item.name.length <= 10)
                subpaperNames.push(item.name);
            }
        }
      }
    } catch (error) {
    //   console.log(`DEBUG [${repo.name}]: Error reading 'papers' directory contents: ${error.message}`);
    }
    return subpaperNames;
  }

  generateStats() {
    this.stats.total = this.papers.length;
    this.stats.byStatus = {};
    this.papers.forEach(paper => { 
        const statusKey = paper.status || 'Unknown'; // Ensure a key even if status is null
        this.stats.byStatus[statusKey] = (this.stats.byStatus[statusKey] || 0) + 1; 
    });
    this.stats.byPriority = {};
    this.papers.forEach(paper => { 
        const priorityKey = paper.priority || 'Medium'; // Ensure a key
        this.stats.byPriority[priorityKey] = (this.stats.byPriority[priorityKey] || 0) + 1; 
    });
    this.stats.recentActivity.sort((a, b) => b.commits - a.commits);
    this.stats.recentActivity = this.stats.recentActivity.slice(0, 10);
  }

  async updateReadme() {
    // console.log('📝 Updating main README.md...');
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    let dashboardUrl = ``;
    if (this.owner && this.repoFullName && this.repoFullName.includes('/')) {
        dashboardUrl = `https://${this.owner}.github.io/${this.repoFullName.split('/')[1]}/`;
    } else {
        dashboardUrl = `<!-- Warning: Hub repo owner or name not found. Update this link manually. -->`;
    }

    let readme = `# 100 Scientific Visions by Daniel Sandner\n\n## Project Overview\nA comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.\n\n## Current Status Dashboard\n*Last updated: ${timestamp}*\n\n### Quick Stats\n- 📊 **Total Papers Tracked**: ${this.stats.total}\n- 🟢 **Active Projects**: ${this.stats.byStatus['Active'] || 0}\n- 🟡 **In Planning**: ${this.stats.byStatus['Planning'] || 0}\n- 🔴 **Stale (Needs Attention)**: ${this.stats.byStatus['Stale'] || 0}\n- 📈 **This Week's Commits (Public Repos)**: ${this.stats.weeklyCommits}\n\n### Recent Activity (Top 10 Public Repos by Weekly Commits)\n`;
    if (this.stats.recentActivity.length > 0) { this.stats.recentActivity.forEach(activity => { readme += `- **${activity.repo}**: ${activity.commits} commits - "${activity.lastCommit.substring(0,70)}${activity.lastCommit.length > 70 ? '...' : ''}"\n`; }); } else { readme += '*No recent commit activity detected in public repositories or data unavailable.*\n'; }
    readme += `\n## Research Areas\n*Categorization based on repository topics or 'Research Area' in 100SV.md files.*\n\n### By Status\n`;
    const sortedStatusKeys = Object.keys(this.stats.byStatus).sort();
    if (sortedStatusKeys.length > 0) {
        sortedStatusKeys.forEach(status => { readme += `- **${status}**: ${this.stats.byStatus[status]} papers\n`; });
    } else {
        readme += `*No status data available.*\n`;
    }
    readme += `\n### Priority Distribution\n`;
    const sortedPriorityKeys = Object.keys(this.stats.byPriority).sort((a,b) => { const order = { High: 0, Medium: 1, Low: 2 }; return (order[a] ?? 99) - (order[b] ?? 99); });
    if (sortedPriorityKeys.length > 0) {
        sortedPriorityKeys.forEach(priority => { const emoji = priority === 'High' ? '🔴' : priority === 'Medium' ? '🟡' : (priority === 'Low' ? '🟢' : '⚪'); readme += `- ${emoji} **${priority} Priority**: ${this.stats.byPriority[priority]} papers\n`; });
    } else {
        readme += `*No priority data available.*\n`;
    }
    readme += `\n## Quick Actions & Links\n- [📊 Interactive Dashboard](${dashboardUrl})\n- [📋 View Detailed Progress Report](./reports/detailed-progress.md)\n- [🔄 Update Status Manually](../../actions) (Run "Update Project Status" workflow)\n\n## About This System\nThis dashboard is automatically updated by GitHub Actions. For more information on setup, repository identification, and customization, see [SETUP.md](./setup.md).\n\n---\n\n*This dashboard is part of the 100 Scientific Visions initiative by Daniel Sandner.*`;
    await fs.writeFile('README.md', readme);
    // console.log('✅ README.md updated successfully.');
  }

  async generateDetailedReport() {
    // console.log('📊 Generating detailed progress report...');
    try {
      await fs.mkdir('reports', { recursive: true });
      const now = new Date(); const generatedDate = now.toISOString().slice(0, 10); const generatedTime = now.toTimeString().slice(0, 8);
      let report = `# Detailed Progress Report\n*Generated: ${generatedDate} ${generatedTime} UTC*\n\n## All Tracked Paper Items (${this.papers.length} total)\n\n`;
      report += `| Title / Location                 | Status                      | Priority                      | Progress                               | Links                                     | Last Repo Update |\n`;
      report += `|:---------------------------------|:----------------------------|:------------------------------|:---------------------------------------|:------------------------------------------|:-----------------|\n`;
      if (this.papers.length === 0) { report += `| *No paper items found or tracked.* | - | - | - | - | - |\n`; }
      else {
        this.papers.forEach(paper => {
          const statusEmoji = this.getStatusEmoji(paper.status); const priorityEmoji = this.getPriorityEmoji(paper.priority);
          const progressBar = this.generateProgressBar(paper.progress?.phase || []);
          const links = [];
          if (paper.preprintLink && paper.preprintLink !== 'null' && !paper.preprintLink.toLowerCase().includes('[link')) { links.push(`[Preprint](${paper.preprintLink})`); }
          if (paper.publishedLink && paper.publishedLink !== 'null' && !paper.publishedLink.toLowerCase().includes('[doi')) { links.push(`[Published](${paper.publishedLink})`); }
          links.push(`[View](${paper.url})`);
          
          let displayName = paper.title || paper.paperName || 'Untitled';
          let locationHint = '';
          if (paper.isSubpaper) {
              locationHint = `<br><small>(${paper.fullName})</small>`;
          } else if (displayName !== paper.repoName) { // For single paper, if title is different from repo name
              locationHint = `<br><small>(${paper.repoName})</small>`;
          }

          report += `| **${displayName}**${locationHint} | ${statusEmoji} ${paper.status || 'N/A'} | ${priorityEmoji} ${paper.priority || 'N/A'} | \`${progressBar}\` | ${links.join(' • ')} | ${new Date(paper.lastUpdated).toLocaleDateString()} |\n`;
        });
      }
      report += `\n## Detailed Information by Repository\n`;
      const papersByRepo = this.papers.reduce((acc, p) => { (acc[p.repoName] = acc[p.repoName] || []).push(p); return acc; }, {});
      if (Object.keys(papersByRepo).length === 0) { report += `*No repositories to detail.*\n`; }
      else {
        Object.keys(papersByRepo).sort().forEach(repoName => {
          const papersInRepo = papersByRepo[repoName]; const repoData = papersInRepo[0];
          report += `\n### 📁 Repository: [${repoName}](${repoData.repoUrl})\n`;
          report += `- **Repo Description**: ${repoData.description || 'N/A (No repo description or 100SV.md research focus)'}\n`;
          report += `- **Topics**: ${(repoData.topics || []).join(', ') || 'None'}\n`;
          report += `- **Visibility**: ${repoData.private ? 'Private' : 'Public'}\n`;
          if (repoData.historical) { report += `- **Created**: ${new Date(repoData.historical.createdAt).toLocaleDateString()} (${repoData.historical.age} days ago)\n`; if (!repoData.private && typeof repoData.historical.totalCommits3Months === 'number') { report += `- **Commits (last 3 months)**: ${repoData.historical.totalCommits3Months}\n`; } }
          if (!repoData.private && typeof repoData.commits === 'number' && repoData.commits > 0) { report += `- **Weekly Commits (repo)**: ${repoData.commits}\n`; }
          if (papersInRepo.length === 1 && !papersInRepo[0].isSubpaper) {
            const paper = papersInRepo[0]; report += `- **Paper Title**: ${paper.title || paper.paperName || '*Not specified*'}\n`; report += `- **Status**: ${this.getStatusEmoji(paper.status)} ${paper.status || 'N/A'}\n`; report += `- **Priority**: ${this.getPriorityEmoji(paper.priority)} ${paper.priority || 'N/A'}\n`; report += `- **Progress**: \`${this.generateProgressBar(paper.progress?.phase || [])}\`\n`;
            if (paper.projectId) report += `- **Project ID**: ${paper.projectId}\n`; if (paper.researchArea) report += `- **Research Area**: ${paper.researchArea}\n`; if (paper.preprintLink) report += `- **Preprint**: [Link](${paper.preprintLink})\n`; if (paper.publishedLink) report += `- **Published**: [Link](${paper.publishedLink})\n`;
          } else {
            report += `\n  *Contains ${papersInRepo.length} paper items:*\n`;
            papersInRepo.forEach(paper => {
              report += `  - #### ${this.getStatusEmoji(paper.status)} ${paper.title || paper.paperName || '*Untitled Sub-paper*'}\n`; if (paper.title && paper.paperName !== paper.title && paper.isSubpaper) { report += `    - **Directory Name**: \`${paper.paperName}\`\n`; }
              report += `    - **Status**: ${paper.status || 'N/A'} | **Priority**: ${paper.priority || 'N/A'}\n`; report += `    - **Progress**: \`${this.generateProgressBar(paper.progress?.phase || [])}\`\n`;
              if (paper.projectId) report += `    - **Project ID**: ${paper.projectId}\n`; if (paper.researchArea) report += `    - **Research Area**: ${paper.researchArea}\n`; if (paper.preprintLink) report += `    - **Preprint**: [Link](${paper.preprintLink})\n`; if (paper.publishedLink) report += `    - **Published**: [Link](${paper.publishedLink})\n`; report += `    - **Link**: [View Paper Directory](${paper.url})\n\n`;
            });
          } report += `\n---\n`;
        });
      }
      await fs.writeFile('reports/detailed-progress.md', report);
      // console.log('✅ Detailed report generated successfully: reports/detailed-progress.md');
    } catch (error) { console.error(`❌ Error generating detailed report: ${error.message}`, error.stack); }
  }

  generateProgressBar(completedPhases) {
    const totalPhases = 12; 
    const completed = Array.isArray(completedPhases) ? completedPhases.length : 0;
    if (totalPhases === 0) return `░░░░░░░░░░ 0% (No phases defined)`; // Avoid division by zero
    const percentage = Math.round((completed / totalPhases) * 100); 
    const filledBlocks = Math.min(10, Math.round((completed / totalPhases) * 10)); 
    const emptyBlocks = 10 - filledBlocks;
    return `${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)} ${percentage}%`;
  }

  getStatusEmoji(status) {
    const emojis = { 'Active': '🟢', 'Planning': '🟡', 'Review': '🔵', 'Complete': '✅', 'Stale': '🔴', 'Inactive': '⚪', 'Recent': '🟠', 'Analysis': '🟣', 'Writing': '✍️', 'On-Hold': '⏸️', 'Unknown': '❓' };
    return emojis[status] || '❓';
  }
  getPriorityEmoji(priority) {
    const emojis = { 'High': '🔴', 'Medium': '🟡', 'Low': '🟢' };
    return emojis[priority] || '⚪'; // Default for unknown priority
  }

  async saveData() {
    // console.log('💾 Saving data to JSON files...');
    await fs.mkdir('data', { recursive: true });
    const sortedPapers = [...this.papers].sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
    await fs.writeFile('data/papers.json', JSON.stringify(sortedPapers, null, 2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats, null, 2));
    // console.log('✅ Data saved to data/papers.json and data/stats.json.');
  }

  async run() {
    console.log('🚀 Starting Scientific Visions Tracker...');
    if (!this.owner) {
        console.error("❌ GITHUB_OWNER environment variable is not set. Cannot determine scan targets.");
        process.exit(1); // Critical error
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
    console.error("❌ Top-level unhandled error in tracker execution:", error);
    process.exit(1);
  }
})();