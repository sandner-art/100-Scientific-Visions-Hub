# 100 Scientific Visions - Setup Instructions

## Quick Start Guide

### 1. Create the Documentation Hub Repository

1. Create a new GitHub repository named `100-scientific-visions-hub`
2. Initialize with the provided README.md content
3. Create the following directory structure:
   ```
   100-scientific-visions-hub/
   ├── README.md
   ├── reports/
   ├── data/
   ├── scripts/
   │   └── update-status.js
   └── .github/
       └── workflows/
           └── update-status.yml
   ```

### 2. Set Up GitHub Actions

1. Create `.github/workflows/update-status.yml` with the provided workflow
2. Create `scripts/update-status.js` with the provided script
3. The workflow will automatically run daily and can be triggered manually

### 3. Prepare Your Paper Repositories

For each paper repository in the 100 Scientific Visions initiative:

1. **Add 100SV.md identifier file** (recommended approach) - Use provided template
2. **Ensure papers/ folder exists** - Contains your research content
3. **Add progress.md file** in the papers/ folder using the provided template  
4. **Alternative identification methods**:
   - Add `100-scientific-visions` as a GitHub topic
   - Use SC- prefix in repository name (legacy support)
   - Include "100 Scientific Visions" in repository description

**For repositories you DON'T want tracked**: Simply don't add any of the above identifiers.

### 4. Configure Repository Access

**For Public Repositories**: No additional setup needed

**For Private Repositories**: 
1. Create a Personal Access Token with `repo` scope
2. Add it as a repository secret named `GH_TOKEN` 
3. Update the workflow to use `${{ secrets.GH_TOKEN }}` instead of `${{ secrets.GITHUB_TOKEN }}`

### 5. First Run

1. Go to your hub repository's Actions tab
2. Click on "Update Project Status" workflow  
3. Click "Run workflow" to trigger the first update
4. Check the results in your updated README.md

## Advanced Configuration

### Multi-Organization Support

To track repositories across multiple organizations/users, edit `scripts/update-status.js`:

```javascript
const targets = [
  { type: 'user', name: 'your-username' },
  { type: 'org', name: 'your-research-org' },
  { type: 'user', name: 'collaborator-username' }
];
```

### Repository Identification Methods

The system uses multiple methods to identify 100SV repositories (in order of priority):

1. **100SV.md file** (Recommended) - Place this file in repository root
2. **GitHub topic tag** - Add `100-scientific-visions` topic to repository
3. **SC- prefix** - Repositories starting with "SC-" + papers folder (legacy support)
4. **Description keywords** - Repositories with "100 Scientific Visions" or "100SV" in description + papers folder

**Recommended Approach**: Add `100SV.md` files to all initiative repositories. This gives you:
- Explicit control over which repos are tracked
- Project metadata and context
- Clear identification for collaborators
- Future-proof identification method

### Historical Data Support

The system automatically tracks:
- **3-month commit history** for existing repositories
- **Repository creation dates** to understand project timeline  
- **Commit trends** to identify active vs. dormant projects
- **Total activity** since initiative start

### Excluding Repositories

Repositories are automatically excluded if they don't have:
- 100SV.md file OR
- 100-scientific-visions topic tag OR  
- SC- prefix + papers folder OR
- Keywords in description + papers folder

For explicit exclusion, remove these identifiers from repositories you don't want tracked.

### Additional Tracking Fields

Extend the progress.md template to include:
- Research area categories
- Collaboration status
- Funding information
- Publication targets

### Custom Reports

The system generates JSON data files in `/data/` that you can use to create:
- Custom dashboards
- Research metrics
- Progress visualizations
- Export to other tools

## Troubleshooting

### Common Issues

**"No papers found"**: 
- Ensure repositories have a `papers/` folder
- Check repository visibility settings
- Verify GitHub token permissions

**"Cannot read progress.md"**:
- File must be at `papers/progress.md` (not root level)
- Check file encoding (should be UTF-8)
- Ensure file exists and has content

**Private repositories not tracked**:
- Add personal access token as repository secret
- Update workflow to use the custom token
- Ensure token has appropriate repository access

### Getting Help

1. Check the Actions logs for detailed error messages
2. Verify all file paths match the expected structure  
3. Test with a single repository first before scaling up
4. Use the manual workflow trigger for debugging

## Next Steps

Once the basic system is working:

1. **Standardize your progress.md files** across all paper repositories
2. **Set up regular update schedule** (daily/weekly based on your needs)
3. **Customize the dashboard** to match your research workflow
4. **Add topic tags** to repositories for better categorization
5. **Consider adding visual charts** using GitHub Pages for richer reporting

The system is designed to grow with your project - start simple and add features as needed!