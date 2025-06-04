This project is designed to implement the feature: Code Reorg

Reorganize the code along functionality boundaries. Currently a lot of things go between the rmfilter, rmplan, rmpr, etc. directories, and it's getting unwieldy.

The rmplan directory should also be reorganized to have better separation of related code, probably with a file for each command.

rmfilter: src/rmplan src/rmpr src/common src/rmfilter