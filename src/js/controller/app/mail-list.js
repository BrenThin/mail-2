'use strict';

var searchTimeout;

//
// Constants
//

var INIT_DISPLAY_LEN = 50,
    SCROLL_DISPLAY_LEN = 10,
    FOLDER_TYPE_INBOX = 'Inbox',
    NOTIFICATION_INBOX_TIMEOUT = 5000;

var MailListCtrl = function($scope, $timeout, $location, $filter, statusDisplay, notification, email, keychain, dialog, search, dummy) {

    //
    // Init
    //

    $scope.state.mailList = {};

    /**
     * Gathers unread notifications to be cancelled later
     */
    $scope.pendingNotifications = [];

    //
    // url/history handling
    //

    /**
     * Set the route to a message which will go to read mode
     */
    $scope.navigate = function(message) {
        $location.search('uid', message.uid);
    };

    $scope.loc = $location;
    $scope.$watch('(loc.search()).uid', function(uid) {
        if (typeof uid === 'undefined') {
            // no uid specified in url... select no message
            $scope.select();
            return;
        }
        // select the message specified by the uid in the url
        $scope.select(_.findWhere(currentFolder().messages, {
            uid: typeof uid === 'string' ? parseInt(uid, 10) : uid
        }));
    });

    //
    // scope functions
    //

    $scope.getBody = function(message) {
        email.getBody({
            folder: currentFolder(),
            message: message
        }, function(err) {
            if (err && err.code !== 42) {
                dialog.error(err);
                return;
            }

            // display fetched body
            $scope.$digest();

            // automatically decrypt if it's the selected message
            if (message === currentMessage()) {
                email.decryptBody({
                    message: message
                }, dialog.error);
            }
        });
    };

    /**
     * Called when clicking on an message list item
     */
    $scope.select = function(message) {
        // unselect an item
        if (!message) {
            $scope.state.mailList.selected = undefined;
            return;
        }

        $scope.state.mailList.selected = message;

        if ($location.search().dev) {
            // stop here in dev mode
            return;
        }

        keychain.refreshKeyForUserId({
            userId: message.from[0].address
        }, onKeyRefreshed);

        function onKeyRefreshed(err) {
            if (err) {
                dialog.error(err);
            }

            email.decryptBody({
                message: message
            }, dialog.error);

            // if the message is unread, please sync the new state.
            // otherweise forget about it.
            if (!message.unread) {
                return;
            }

            // let's close pending notifications for unread messages in the inbox
            if (currentFolder().type === FOLDER_TYPE_INBOX) {
                while ($scope.pendingNotifications.length) {
                    notification.close($scope.pendingNotifications.shift());
                }
            }

            $scope.state.actionBar.markMessage(message, false, true);
        }
    };

    $scope.flag = function(message, flagged) {
        $scope.state.actionBar.flagMessage(message, flagged);
    };

    /**
     * Date formatting
     */
    $scope.formatDate = function(date) {
        var now = new Date();

        // return time if mail is from today
        if (now.getDay() === date.getDay() && now.getMonth() === date.getMonth() && now.getFullYear() === date.getFullYear()) {
            return $filter('date')(date, 'shortTime');
        }

        return $filter('date')(date, 'mediumDate');
    };

    //
    // watch tasks
    //

    /**
     * List messages from folder when user changes folder
     */
    $scope._stopWatchTask = $scope.$watch('state.nav.currentFolder', function() {
        if (!currentFolder()) {
            return;
        }

        // reset searchFilter
        $scope.searchText = undefined;

        // in development, display dummy mail objects
        if ($location.search().dev) {
            statusDisplay.update('Last update: ', new Date());
            currentFolder().messages = dummy.listMails();
            return;
        }

        // display and select first
        openCurrentFolder();
    });

    $scope.watchMessages = $scope.$watchCollection('state.nav.currentFolder.messages', function(messages) {
        if (!messages) {
            return;
        }

        // sort message by uid
        messages.sort(byUidDescending);
        // set display buffer to first messages
        $scope.displayMessages = messages.slice(0, INIT_DISPLAY_LEN);
    });

    /**
     * display more items (for infinite scrolling)
     */
    $scope.displayMore = function() {
        if (!currentFolder() || !$scope.displayMessages) {
            // folders not yet initialized
            return;
        }

        var len = currentFolder().messages.length,
            dLen = $scope.displayMessages.length;

        if (dLen === len || $scope.searchText) {
            // all messages are already displayed or we're in search mode
            return;
        }

        // copy next interval of messages to the end of the display messages array
        var next = currentFolder().messages.slice(dLen, dLen + SCROLL_DISPLAY_LEN);
        Array.prototype.push.apply($scope.displayMessages, next);
    };

    /**
     * Handle search event in other parts of the app by filtering messages in the mail-list
     */
    $scope.$on('search', function(e, query) {
        $scope.displaySearchResults(query);
    });

    /**
     * This method is called when the user changes the searchText
     */
    $scope.displaySearchResults = function(searchText) {
        if (searchTimeout) {
            // remove timeout to wait for user typing query
            clearTimeout(searchTimeout);
        }

        if (!searchText) {
            // set display buffer to first messages
            $scope.displayMessages = currentFolder().messages.slice(0, INIT_DISPLAY_LEN);
            statusDisplay.setSearching(false);
            statusDisplay.update('Online');
            return;
        }

        // display searching spinner
        statusDisplay.setSearching(true);
        statusDisplay.update('Searching ...');
        searchTimeout = setTimeout(function() {
            $scope.$apply(function() {
                // filter relevant messages
                $scope.displayMessages = search.filter(currentFolder().messages, searchText);
                statusDisplay.setSearching(false);
                statusDisplay.update('Matches in this folder');
            });
        }, 500);
    };

    /**
     * Sync current folder when client comes back online
     */
    $scope.watchOnline = $scope.$watch('account.online', function(isOnline) {
        // wait one cycle for the status display controllers to init
        $timeout(function() {
            if (isOnline) {
                statusDisplay.update('Online');
                openCurrentFolder();
            } else {
                statusDisplay.update('Offline mode');
            }
        });
    }, true);

    //
    // Helper Functions
    //

    function openCurrentFolder() {
        if (!currentFolder()) {
            return;
        }

        email.openFolder({
            folder: currentFolder()
        }, function(error) {
            // dont wait until scroll to load visible mail bodies
            $scope.loadVisibleBodies();

            // don't display error for offline case
            if (error && error.code === 42) {
                return;
            }
            dialog.error(error);
        });
    }

    function currentFolder() {
        return $scope.state.nav && $scope.state.nav.currentFolder;
    }

    function currentMessage() {
        return $scope.state.mailList.selected;
    }

    //
    // Notification API
    //

    (email || {}).onIncomingMessage = function(msgs) {
        var note, title, message, unreadMsgs;

        unreadMsgs = msgs.filter(function(msg) {
            return msg.unread;
        });

        if (unreadMsgs.length === 0) {
            return;
        }

        if (unreadMsgs.length === 1) {
            title = unreadMsgs[0].from[0].name || unreadMsgs[0].from[0].address;
            message = unreadMsgs[0].subject;
        } else {
            title = unreadMsgs.length + ' new messages';
            message = _.pluck(unreadMsgs, 'subject').join('\n');
        }

        note = notification.create({
            title: title,
            message: message,
            onClick: function() {
                // remove from pending notificatiosn
                var index = $scope.pendingNotifications.indexOf(note);
                if (index !== -1) {
                    $scope.pendingNotifications.splice(index, 1);
                }
                // open the message
                $scope.navigate(_.findWhere(currentFolder().messages, {
                    uid: unreadMsgs[0].uid
                }));
            },
            timeout: NOTIFICATION_INBOX_TIMEOUT
        });
        $scope.pendingNotifications.push(note);
    };
};

//
// Directives
//

var ngModule = angular.module('mail-list', []);

ngModule.directive('listScroll', function() {
    return {
        link: function(scope, elm, attrs) {
            var model = attrs.listScroll,
                listEl = elm[0],
                scrollTimeout;

            /*
             * iterates over the mails in the mail list and loads their bodies if they are visible in the viewport
             */
            scope.loadVisibleBodies = function() {
                var listBorder = listEl.getBoundingClientRect(),
                    top = listBorder.top,
                    bottom = listBorder.bottom,
                    listItems = listEl.children[0].children,
                    inViewport = false,
                    listItem, message,
                    isPartiallyVisibleTop, isPartiallyVisibleBottom, isVisible,
                    displayMessages = scope[model];

                if (!top && !bottom) {
                    // list not visible
                    return;
                }

                for (var i = 0, len = listItems.length; i < len; i++) {
                    // the n-th list item (the dom representation of an message) corresponds to
                    // the n-th message model in the filteredMessages array
                    listItem = listItems.item(i).getBoundingClientRect();

                    if (!displayMessages || displayMessages.length <= i) {
                        // stop if i get larger than the size of filtered messages
                        break;
                    }
                    message = displayMessages[i];


                    isPartiallyVisibleTop = listItem.top < top && listItem.bottom > top; // a portion of the list item is visible on the top
                    isPartiallyVisibleBottom = listItem.top < bottom && listItem.bottom > bottom; // a portion of the list item is visible on the bottom
                    isVisible = (listItem.top || listItem.bottom) && listItem.top >= top && listItem.bottom <= bottom; // the list item is visible as a whole

                    if (isPartiallyVisibleTop || isVisible || isPartiallyVisibleBottom) {
                        // we are now iterating over visible elements
                        inViewport = true;
                        // load mail body of visible
                        scope.getBody(message);
                    } else if (inViewport) {
                        // we are leaving the viewport, so stop iterating over the items
                        break;
                    }
                }
            };

            // load body when scrolling
            listEl.onscroll = function() {
                if (scrollTimeout) {
                    // remove timeout so that only scroll end
                    clearTimeout(scrollTimeout);
                }
                scrollTimeout = setTimeout(function() {
                    scope.loadVisibleBodies();
                }, 300);
            };

            // load the visible message bodies, when the list is re-initialized and when scrolling stopped
            scope.$watchCollection(model, function() {
                scope.loadVisibleBodies();
            });
        }
    };
});

function byUidDescending(a, b) {
    if (a.uid < b.uid) {
        return 1;
    } else if (b.uid < a.uid) {
        return -1;
    } else {
        return 0;
    }
}

module.exports = MailListCtrl;