This project is designed to implement the feature: PR Handler: Allow changing settings after selecting comments

Two main things here, both around the idea that you don't always know what you want until after selecting comments to address:
 
- You may want to add extra rmfilter options to bring in extra files related to the selected comments
- If the comments are all really simple things you may want to use a lightweight model for the edit

At the place where we let you review the comments and then press Enter, we should also allow 'm' for a model picker (using https://github.com/SBoudrias/Inquirer.js/tree/main/packages/search probably) and 'r' to edit the rmfilter command line or add more options. Use https://github.com/SBoudrias/Inquirer.js/tree/main/packages/expand for the selector here and run it in a loop until the user continues.