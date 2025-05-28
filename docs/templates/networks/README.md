# Scientific papers visualization dashboard

- uses D3.js for the network visualization with force-directed layout, color-coded topic clusters, and interactive features,
that combines the best aspects of network diagrams and interactive clustering.

## Key Features:

**1. Network Visualization**
- Force-directed layout showing relationships between topics and keywords
- Color-coded topic categories with distinct visual hierarchy
- Interactive nodes that can be dragged and explored

**2. Dual View Modes**
- **Network View**: Natural force-directed layout showing all connections
- **Cluster View**: Groups related topics and keywords into thematic clusters

**3. Scalable Design**
- Handles 100+ papers efficiently (demonstrated with sample data)
- Node sizes scale with frequency/importance
- Connection strength varies with relationship frequency

**4. Modern UI Elements**
- Glassmorphism design with backdrop blur effects
- Smooth animations and hover interactions
- Responsive legend panel with topic color coding
- Real-time statistics display

**5. Interactive Features**
- Zoom and pan functionality
- Drag nodes to explore relationships
- Hover tooltips with detailed information
- View switching between network and cluster modes

## Technical Advantages:

- **Component-Ready**: Built as a self-contained HTML component that can be easily integrated into existing pages
- **Performance Optimized**: Uses D3.js with efficient force simulation algorithms
- **Responsive Design**: Adapts to different screen sizes
- **Data Structure**: Easy to replace sample data with your actual JSON structure

## Data Structure Expected:
```json
{
  "papers": [
    {
      "id": 1,
      "title": "Paper Title",
      "topics": ["Topic 1", "Topic 2"],
      "keywords": ["keyword1", "keyword2", "keyword3"]
    }
  ]
}
```

The visualization automatically:
- Aggregates topic and keyword frequencies across all papers
- Creates connections based on co-occurrence in papers
- Applies color coding to distinguish topic categories
- Scales node sizes based on frequency/importance

## Update

Here's a summary of the changes:

1.  **Label Display Improvements**:
    *   All nodes (topics and keywords) will now display labels, removing the previous size-based filter.
    *   Labels for topics are positioned above the node, and labels for keywords are positioned below.
    *   Text truncation is implemented for long labels (e.g., "Long Label...") instead of text wrapping, which improves readability and significantly boosts performance. Max length is 18 characters for topics and 12 for keywords.
    *   Distinct styling (font size, weight) is applied to topic and keyword labels via CSS classes.

2.  **Performance Enhancements**:
    *   The complex and slow `wrapText` function has been removed and replaced with simple text truncation.
    *   The D3 simulation's `alphaTarget` during drag operations is reduced from `0.3` to `0.1` for smoother dragging.
    *   Overall simulation parameters `alphaDecay` (set to `0.025`) and `velocityDecay` (set to `0.45`) are tuned for potentially smoother animations and settling.

3.  **Label Toggle Feature**:
    *   An HTML checkbox labeled "Show Labels" is added to the controls panel.
    *   This checkbox allows users to toggle the visibility of all node labels.
    *   Label visibility is managed efficiently using a CSS class (`.hidden`).

4.  **Code Quality and D3 Best Practices**:
    *   Labels are now managed using D3's `.join()` pattern, which is more robust for data updates (though data isn't dynamic in this specific example, it's good practice).
    *   CSS classes are used more effectively for styling and visibility control, leading to cleaner JavaScript.
    *   A global helper function `truncateText` is introduced for cleaner code.

