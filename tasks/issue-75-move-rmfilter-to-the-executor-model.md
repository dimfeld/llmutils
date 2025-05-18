This project is designed to implement the feature: Move rmfilter to the executor model

Like the `rmplan` command, `rmfilter` should replace it's --run option with an optional --executor option which will create an executor and then call it instead of `runPrompt`. If no executor is provided, treat it like in the existing code when options.run is false.

rmfilter: src/rmfilter src/rmplan/executors